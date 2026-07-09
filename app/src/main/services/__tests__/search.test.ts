import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact } from '../ingest'
import { searchEvidence, readEvidenceText } from '../search'
import type { DatabaseSync } from 'node:sqlite'

const FIXTURE = path.resolve(__dirname, '../../../../../tests/fixtures/sample-applog.txt')

let home: string
let db: DatabaseSync

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-search-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'NAVAPI-1', title: 'a' })
  createCase(db, home, { slug: 'NAVAPI-2', title: 'b' })
  ingestArtifact(db, home, 'NAVAPI-1', FIXTURE)
  ingestArtifact(db, home, 'NAVAPI-2', FIXTURE)
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
