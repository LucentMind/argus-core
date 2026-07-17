import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact } from '../ingest'
import { createDetection } from '../packs/detection'
import { searchEvidence, readEvidenceText, readEvidenceSnippet } from '../search'
import { SNIPPET_BEFORE, SNIPPET_AFTER, MAX_SNIPPET_LINES } from '../../../shared/snippets'
import type { DatabaseSync } from 'node:sqlite'

const FIXTURE = path.resolve(__dirname, '../../../../../tests/fixtures/sample-applog.txt')

let home: string
let db: DatabaseSync
const detection = createDetection()

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-search-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'NAVAPI-1', title: 'a' })
  createCase(db, home, { slug: 'NAVAPI-2', title: 'b' })
  ingestArtifact(db, home, detection, 'NAVAPI-1', FIXTURE)
  ingestArtifact(db, home, detection, 'NAVAPI-2', FIXTURE)
})

describe('searchEvidence', () => {
  it('finds hits with snippet and line range', () => {
    const hits = searchEvidence(db, 'TileStore error')
    expect(hits.length).toBe(2)
    expect(hits[0].snippet).toContain('«TileStore»')
    expect(hits[0].startLine).toBe(1)
    expect(hits[0].relPath).toBe('evidence/sample-applog.txt')
  })

  it('resolves the exact matching line within the chunk', () => {
    // fixture line 3 is the only line containing both terms
    const hits = searchEvidence(db, 'TileStore error', { caseSlug: 'NAVAPI-1' })
    expect(hits[0].matchLine).toBe(3)
    // single-term query on a line further down
    const noRoute = searchEvidence(db, 'NoRoute', { caseSlug: 'NAVAPI-1' })
    expect(noRoute[0].matchLine).toBe(5)
  })

  it('filters by case', () => {
    const hits = searchEvidence(db, 'TileStore', { caseSlug: 'NAVAPI-2' })
    expect(hits.length).toBe(1)
    expect(hits[0].caseSlug).toBe('NAVAPI-2')
  })

  it('filters by artifact type (no applog hits when filtering screenshots)', () => {
    expect(searchEvidence(db, 'TileStore', { artifactType: 'screenshot' })).toEqual([])
  })

  it('does not choke on FTS special characters', () => {
    expect(() => searchEvidence(db, 'sample-dataset/2025_12_10-03_00_00 "quoted"')).not.toThrow()
  })

  it('returns empty for blank queries', () => {
    expect(searchEvidence(db, '   ')).toEqual([])
  })
})

describe('readEvidenceText', () => {
  it('reads content by evidence id', () => {
    const [hit] = searchEvidence(db, 'NoRoute', { caseSlug: 'NAVAPI-1' })
    const doc = readEvidenceText(db, home, hit.evidenceId)
    expect(doc.caseSlug).toBe('NAVAPI-1')
    expect(doc.content).toContain('Router error: NoRoute')
  })
})

describe('readEvidenceSnippet', () => {
  it('returns a window around the target line, clamped at the start of file', () => {
    const r = readEvidenceSnippet(db, home, 'NAVAPI-1', 'evidence/sample-applog.txt', 3)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.startLine).toBe(1) // max(1, 3-4) = 1
    expect(r.lines.length).toBeLessThanOrEqual(SNIPPET_BEFORE + 1 + SNIPPET_AFTER)
    expect(r.lines[3 - r.startLine]).toContain('TileStore')
    expect(r.lang).toBeNull() // .txt is plain
    expect(typeof r.evidenceId).toBe('number')
    expect(r.relPath).toBe('evidence/sample-applog.txt')
  })

  it('fills lang for code extensions', () => {
    const src = path.join(home, 'util.ts')
    fs.writeFileSync(src, 'const a = 1\nconst b = 2\nconst c = 3\n')
    ingestArtifact(db, home, detection, 'NAVAPI-1', src)
    const r = readEvidenceSnippet(db, home, 'NAVAPI-1', 'evidence/util.ts', 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lang).toBe('typescript')
    expect(r.lines[2 - r.startLine]).toBe('const b = 2')
  })

  it('returns not-found for an unknown relPath and an unknown case', () => {
    expect(readEvidenceSnippet(db, home, 'NAVAPI-1', 'evidence/nope.log', 1)).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(readEvidenceSnippet(db, home, 'NO-SUCH-CASE', 'evidence/sample-applog.txt', 1)).toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('returns empty lines with eof for a target beyond the end of file', () => {
    const r = readEvidenceSnippet(db, home, 'NAVAPI-1', 'evidence/sample-applog.txt', 100000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lines).toEqual([])
    expect(r.eof).toBe(true)
  })

  it('windows around a range: start-BEFORE to end+AFTER', () => {
    const src = path.join(home, 'range.ts')
    fs.writeFileSync(src, Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
    ingestArtifact(db, home, detection, 'NAVAPI-1', src)
    const r = readEvidenceSnippet(db, home, 'NAVAPI-1', 'evidence/range.ts', 20, 24)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.startLine).toBe(20 - SNIPPET_BEFORE)
    expect(r.lines[0]).toBe(`line ${20 - SNIPPET_BEFORE}`)
    expect(r.lines[r.lines.length - 1]).toBe(`line ${24 + SNIPPET_AFTER}`)
    expect(r.truncated).toBe(false)
  })

  it('caps huge ranges at MAX_SNIPPET_LINES and flags truncated', () => {
    const src = path.join(home, 'big.ts')
    fs.writeFileSync(src, Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
    ingestArtifact(db, home, detection, 'NAVAPI-1', src)
    const r = readEvidenceSnippet(db, home, 'NAVAPI-1', 'evidence/big.ts', 10, 150)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lines.length).toBe(MAX_SNIPPET_LINES)
    expect(r.startLine).toBe(10 - SNIPPET_BEFORE)
    expect(r.truncated).toBe(true)
  })

  it('single-line call keeps prior behavior (end defaults to start)', () => {
    const r = readEvidenceSnippet(db, home, 'NAVAPI-1', 'evidence/sample-applog.txt', 3)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.startLine).toBe(1)
    expect(r.truncated).toBe(false)
  })
})
