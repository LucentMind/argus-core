import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact } from '../ingest'
import { createDetection } from '../packs/detection'
import { searchEvidence, readEvidenceText, readEvidenceSnippet } from '../search'
import { indexEvidenceFile } from '../indexer'
import { withFtsSavepoint } from '../ftsIndex'
import { SNIPPET_BEFORE, SNIPPET_AFTER, MAX_SNIPPET_LINES } from '../../../shared/snippets'
import type { DatabaseSync } from 'node:sqlite'
import { createImmediateQueue } from '../ingestQueue'

const FIXTURE = path.resolve(__dirname, '../../../../../tests/fixtures/sample-applog.txt')

let home: string
let db: DatabaseSync
const detection = createDetection()

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-search-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'NAVAPI-1', title: 'a' })
  createCase(db, home, { slug: 'NAVAPI-2', title: 'b' })
  await ingestArtifact(db, home, detection, createImmediateQueue(db, home), 'NAVAPI-1', FIXTURE)
  await ingestArtifact(db, home, detection, createImmediateQueue(db, home), 'NAVAPI-2', FIXTURE)
})

describe('searchEvidence', () => {
  it('finds hits with snippet and line range', () => {
    const hits = searchEvidence(db, home, 'TileStore error')
    expect(hits.length).toBe(2)
    expect(hits[0].snippet).toContain('«TileStore»')
    expect(hits[0].startLine).toBe(1)
    expect(hits[0].relPath).toBe('evidence/sample-applog.txt')
  })

  it('resolves the exact matching line within the chunk', () => {
    // fixture line 3 is the only line containing both terms
    const hits = searchEvidence(db, home, 'TileStore error', { caseSlug: 'NAVAPI-1' })
    expect(hits[0].matchLine).toBe(3)
    // single-term query on a line further down
    const noRoute = searchEvidence(db, home, 'NoRoute', { caseSlug: 'NAVAPI-1' })
    expect(noRoute[0].matchLine).toBe(5)
  })

  it('filters by case', () => {
    const hits = searchEvidence(db, home, 'TileStore', { caseSlug: 'NAVAPI-2' })
    expect(hits.length).toBe(1)
    expect(hits[0].caseSlug).toBe('NAVAPI-2')
  })

  it('filters by artifact type (no applog hits when filtering screenshots)', () => {
    expect(searchEvidence(db, home, 'TileStore', { artifactType: 'screenshot' })).toEqual([])
  })

  it('does not choke on FTS special characters', () => {
    expect(() =>
      searchEvidence(db, home, 'sample-dataset/2025_12_10-03_00_00 "quoted"')
    ).not.toThrow()
  })

  it('returns empty for blank queries', () => {
    expect(searchEvidence(db, home, '   ')).toEqual([])
  })
})

describe('searchEvidence evidence scope', () => {
  beforeEach(async () => {
    const artifact = path.join(home, 'ci-verify.log')
    fs.writeFileSync(artifact, 'TileStore error inside a review artifact\n')
    await ingestArtifact(
      db,
      home,
      detection,
      createImmediateQueue(db, home),
      'NAVAPI-1',
      artifact,
      'upload',
      {},
      'review'
    )
  })

  it('excludes the review artifacts tree by default', () => {
    const hits = searchEvidence(db, home, 'TileStore', { caseSlug: 'NAVAPI-1' })
    expect(hits.map((h) => h.relPath)).toEqual(['evidence/sample-applog.txt'])
  })

  it('returns only artifacts for the review scope', () => {
    const hits = searchEvidence(db, home, 'TileStore', {
      caseSlug: 'NAVAPI-1',
      evidenceScope: 'review'
    })
    expect(hits.map((h) => h.relPath)).toEqual(['artifacts/ci-verify.log'])
  })

  it('returns both trees for the all scope', () => {
    const hits = searchEvidence(db, home, 'TileStore', {
      caseSlug: 'NAVAPI-1',
      evidenceScope: 'all'
    })
    expect(hits.map((h) => h.relPath).sort()).toEqual([
      'artifacts/ci-verify.log',
      'evidence/sample-applog.txt'
    ])
  })

  it('composes with the case and artifact-type filters', () => {
    // the artifact lives in NAVAPI-1, so an all-scope NAVAPI-2 search must not see it
    const other = searchEvidence(db, home, 'TileStore', {
      caseSlug: 'NAVAPI-2',
      evidenceScope: 'all'
    })
    expect(other.map((h) => h.relPath)).toEqual(['evidence/sample-applog.txt'])
    expect(other.every((h) => h.caseSlug === 'NAVAPI-2')).toBe(true)

    const wrongType = searchEvidence(db, home, 'TileStore', {
      caseSlug: 'NAVAPI-1',
      evidenceScope: 'review',
      artifactType: 'screenshot'
    })
    expect(wrongType).toEqual([])
  })
})

describe('readEvidenceText', () => {
  it('reads content by evidence id', () => {
    const [hit] = searchEvidence(db, home, 'NoRoute', { caseSlug: 'NAVAPI-1' })
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

  it('fills lang for code extensions', async () => {
    const src = path.join(home, 'util.ts')
    fs.writeFileSync(src, 'const a = 1\nconst b = 2\nconst c = 3\n')
    await ingestArtifact(db, home, detection, createImmediateQueue(db, home), 'NAVAPI-1', src)
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

  it('windows around a range: start-BEFORE to end+AFTER', async () => {
    const src = path.join(home, 'range.ts')
    fs.writeFileSync(src, Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
    await ingestArtifact(db, home, detection, createImmediateQueue(db, home), 'NAVAPI-1', src)
    const r = readEvidenceSnippet(db, home, 'NAVAPI-1', 'evidence/range.ts', 20, 24)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.startLine).toBe(20 - SNIPPET_BEFORE)
    expect(r.lines[0]).toBe(`line ${20 - SNIPPET_BEFORE}`)
    expect(r.lines[r.lines.length - 1]).toBe(`line ${24 + SNIPPET_AFTER}`)
    expect(r.truncated).toBe(false)
  })

  it('caps huge ranges at MAX_SNIPPET_LINES and flags truncated', async () => {
    const src = path.join(home, 'big.ts')
    fs.writeFileSync(src, Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
    await ingestArtifact(db, home, detection, createImmediateQueue(db, home), 'NAVAPI-1', src)
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

let clCounter = 0

/** Seeds one case + one on-disk evidence file, indexed via indexEvidenceFile (the same
 *  path production ingestion uses), without the full ingestArtifact pipeline. Pass a prior
 *  return value as `reuse` to add a second file to the same db/argusHome (a distinct case
 *  each time, so the two evidence rows never collide on rel_path). */
function seedCaseWithFile(
  relName: string,
  content: string,
  reuse?: { db: DatabaseSync; argusHome: string }
): { db: DatabaseSync; argusHome: string; slug: string; evidenceId: number; absPath: string } {
  const argusHomeLocal =
    reuse?.argusHome ?? fs.mkdtempSync(path.join(os.tmpdir(), 'argus-search-cl-'))
  const dbLocal = reuse?.db ?? openDb(path.join(argusHomeLocal, 'argus.db'))
  const slug = `CL-${++clCounter}`
  createCase(dbLocal, argusHomeLocal, { slug, title: slug })
  const dir = path.join(argusHomeLocal, 'cases', slug, 'evidence')
  fs.mkdirSync(dir, { recursive: true })
  const absPath = path.join(dir, relName)
  fs.writeFileSync(absPath, content)
  const relPath = `evidence/${relName}`
  const caseId = (
    dbLocal.prepare(`SELECT id FROM cases WHERE slug = ?`).get(slug) as { id: number }
  ).id
  const sha256 = crypto.createHash('sha256').update(content).digest('hex')
  const evidenceId = Number(
    dbLocal
      .prepare(
        `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
         VALUES (?, ?, ?, 'text', ?, 'upload', '{}', ?)`
      )
      .run(caseId, relPath, sha256, fs.statSync(absPath).size, new Date().toISOString())
      .lastInsertRowid
  )
  indexEvidenceFile(dbLocal, evidenceId, absPath, 400, argusHomeLocal)
  return { db: dbLocal, argusHome: argusHomeLocal, slug, evidenceId, absPath }
}

describe('searchEvidence over a contentless index', () => {
  it('returns a snippet read from the file, with the match marked', () => {
    const { db, argusHome, slug } = seedCaseWithFile(
      'app.log',
      ['noise line', 'ERROR connection refused by peer', 'more noise'].join('\n') + '\n'
    )
    const hits = searchEvidence(db, argusHome, 'connection refused')
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toContain('«connection»')
    expect(hits[0].snippet).toContain('«refused»')
    expect(hits[0].relPath).toBe(`evidence/app.log`)
    expect(hits[0].caseSlug).toBe(slug)
  })

  it('deep-links to the matching line, not the chunk start', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`)
    lines[41] = 'the needle is here'
    const { db, argusHome } = seedCaseWithFile('big.log', lines.join('\n') + '\n')
    const hits = searchEvidence(db, argusHome, 'needle')
    expect(hits[0].matchLine).toBe(42)
  })

  it('marks a hit whose file has been deleted instead of throwing', () => {
    const { db, argusHome, absPath } = seedCaseWithFile('gone.log', 'findable content\n')
    fs.rmSync(absPath)
    const hits = searchEvidence(db, argusHome, 'findable')
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toBe('[file missing — rescan or remove]')
  })

  it('marks a hit whose file becomes unreadable after indexing', () => {
    const { db, argusHome, absPath } = seedCaseWithFile('readable.log', 'findable content\n')
    // Replace the file with a directory at the same path. This passes existsSync
    // but throws EISDIR on open, testing the catch block in chunkText.
    fs.rmSync(absPath)
    fs.mkdirSync(absPath)
    const hits = searchEvidence(db, argusHome, 'findable')
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toBe('[file missing — rescan or remove]')
  })

  it('one unreadable file does not lose the other hits', () => {
    const a = seedCaseWithFile('a.log', 'shared token here\n')
    const b = seedCaseWithFile('b.log', 'shared token also\n', a)
    fs.rmSync(a.absPath)
    const hits = searchEvidence(a.db, a.argusHome, 'shared')
    expect(hits).toHaveLength(2)
    expect(hits.filter((h) => h.snippet.includes('«shared»'))).toHaveLength(1)
    expect(b.slug).toBeTruthy()
  })

  it('finds rows still living in the legacy table', () => {
    const { db, argusHome, evidenceId } = seedCaseWithFile('legacy.log', 'legacy phrase here\n')
    // move this evidence's chunks back to the legacy shape, as a pre-migration row
    db.exec(`DELETE FROM evidence_index`)
    db.exec(`DELETE FROM evidence_index_map`)
    withFtsSavepoint(db, () => {
      const rowid = db
        .prepare(
          `INSERT INTO evidence_fts (content, evidence_id, chunk_index, start_line, end_line)
           VALUES ('legacy phrase here', ?, 0, 1, 1)`
        )
        .run(evidenceId).lastInsertRowid
      db.prepare(`INSERT INTO evidence_fts_map (fts_rowid, evidence_id) VALUES (?, ?)`).run(
        rowid,
        evidenceId
      )
    })
    const hits = searchEvidence(db, argusHome, 'legacy phrase')
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toContain('«legacy»')
  })

  it('still searches after the legacy table has been dropped', () => {
    const { db, argusHome } = seedCaseWithFile('post.log', 'survives the drop\n')
    db.exec(`DROP TABLE evidence_fts`)
    db.exec(`DROP TABLE evidence_fts_map`)
    const hits = searchEvidence(db, argusHome, 'survives')
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toContain('«survives»')
  })

  it('does not return the same evidence twice when it exists in both tables', () => {
    const { db, argusHome, evidenceId } = seedCaseWithFile('dup.log', 'duplicated token\n')
    withFtsSavepoint(db, () => {
      const rowid = db
        .prepare(
          `INSERT INTO evidence_fts (content, evidence_id, chunk_index, start_line, end_line)
           VALUES ('duplicated token', ?, 0, 1, 1)`
        )
        .run(evidenceId).lastInsertRowid
      db.prepare(`INSERT INTO evidence_fts_map (fts_rowid, evidence_id) VALUES (?, ?)`).run(
        rowid,
        evidenceId
      )
    })
    const hits = searchEvidence(db, argusHome, 'duplicated')
    expect(hits.filter((h) => h.evidenceId === evidenceId)).toHaveLength(1)
  })
})
