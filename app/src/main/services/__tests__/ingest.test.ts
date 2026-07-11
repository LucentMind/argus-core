import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact, ingestContent, listEvidence, updateEvidenceContent } from '../ingest'
import { createDetection } from '../packs/detection'
import { samplePackRegistry } from '../packs/__tests__/fixtures'
import type { DatabaseSync } from 'node:sqlite'

const FIXTURE = path.resolve(__dirname, '../../../../../tests/fixtures/sample-applog.txt')

let home: string
let db: DatabaseSync
const detection = createDetection(samplePackRegistry())

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ing-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'NAVAPI-1', title: 'test' })
})

describe('ingestArtifact', () => {
  it('copies, hashes, types, and indexes a applog', () => {
    const rec = ingestArtifact(db, home, detection, 'NAVAPI-1', FIXTURE)
    expect(rec.artifactType).toBe('applog')
    expect(rec.relPath).toBe('evidence/sample-applog.txt')
    expect(rec.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.existsSync(path.join(home, 'cases/NAVAPI-1', rec.relPath))).toBe(true)
    expect(
      fs.existsSync(path.join(home, 'cases/NAVAPI-1/evidence/.meta/sample-applog.txt.json'))
    ).toBe(true)
    const hit = db
      .prepare(`SELECT evidence_id FROM evidence_fts WHERE evidence_fts MATCH ?`)
      .get('"TileStore error"') as { evidence_id: number } | undefined
    expect(hit?.evidence_id).toBe(rec.id)
  })

  it('suffixes filename collisions', () => {
    const a = ingestArtifact(db, home, detection, 'NAVAPI-1', FIXTURE)
    const b = ingestArtifact(db, home, detection, 'NAVAPI-1', FIXTURE)
    expect(a.relPath).toBe('evidence/sample-applog.txt')
    expect(b.relPath).toBe('evidence/sample-applog-1.txt')
  })

  it('preserves compound extensions on collision (.rec.gz stays archive-rec)', () => {
    const src = path.join(os.tmpdir(), `argus-fix-${Date.now()}`, 'trace.rec.gz')
    fs.mkdirSync(path.dirname(src), { recursive: true })
    fs.writeFileSync(src, zlib.gzipSync(Buffer.from('x')))
    const a = ingestArtifact(db, home, detection, 'NAVAPI-1', src)
    const b = ingestArtifact(db, home, detection, 'NAVAPI-1', src)
    expect(a.relPath).toBe('evidence/trace.rec.gz')
    expect(b.relPath).toBe('evidence/trace-1.rec.gz')
    expect(a.artifactType).toBe('archive-rec')
    expect(b.artifactType).toBe('archive-rec')
  })

  it('throws for unknown case', () => {
    expect(() => ingestArtifact(db, home, detection, 'NOPE-1', FIXTURE)).toThrow(/case/i)
  })

  it('lists evidence for a case', () => {
    ingestArtifact(db, home, detection, 'NAVAPI-1', FIXTURE)
    const all = listEvidence(db, 'NAVAPI-1')
    expect(all).toHaveLength(1)
    expect(all[0].artifactType).toBe('applog')
  })

  it('ingestArtifact merges extraMeta into meta', () => {
    const src = path.join(home, 'a.txt')
    fs.writeFileSync(src, 'hello')
    const rec = ingestArtifact(db, home, detection, 'NAVAPI-1', src, 'jira', {
      jira: { key: 'NAVAPI-1', attachmentId: '10001' }
    })
    expect(rec.origin).toBe('jira')
    expect(rec.meta.jira).toEqual({ key: 'NAVAPI-1', attachmentId: '10001' })
    expect(rec.meta.originalName).toBe('a.txt')
  })

  it('ingestContent writes, detects, indexes and records provenance', () => {
    const rec = ingestContent(
      db,
      home,
      detection,
      'NAVAPI-1',
      'NAVAPI-1.ticket.md',
      '# NAVAPI-1: crash\n\nsteering wheel fault text',
      'jira',
      {
        jira: { key: 'NAVAPI-1', role: 'ticket', status: 'Open', syncedAt: '2026-07-10T00:00:00Z' }
      }
    )
    expect(rec.relPath).toBe('evidence/NAVAPI-1.ticket.md')
    expect(rec.artifactType).toBe('text')
    expect(rec.origin).toBe('jira')
    // FTS-indexed (spec §3.2.3)
    const hit = db
      .prepare(`SELECT evidence_id FROM evidence_fts WHERE evidence_fts MATCH 'steering' LIMIT 1`)
      .get() as { evidence_id: number }
    expect(hit.evidence_id).toBe(rec.id)
    // sidecar written
    expect(
      fs.existsSync(path.join(home, 'cases/NAVAPI-1/evidence/.meta/NAVAPI-1.ticket.md.json'))
    ).toBe(true)
  })

  it('updateEvidenceContent overwrites in place, re-indexes, merges meta', () => {
    const rec = ingestContent(
      db,
      home,
      detection,
      'NAVAPI-1',
      'NAVAPI-1.ticket.md',
      'old body alpha',
      'jira',
      {
        jira: { key: 'NAVAPI-1', role: 'ticket', status: 'Open' }
      }
    )
    const upd = updateEvidenceContent(db, home, detection, rec.id, 'new body omega', {
      jira: { key: 'NAVAPI-1', role: 'ticket', status: 'Resolved' }
    })
    expect(upd.id).toBe(rec.id)
    expect(upd.relPath).toBe(rec.relPath) // same file, no new evidence row
    expect(upd.sha256).not.toBe(rec.sha256)
    expect((upd.meta.jira as { status: string }).status).toBe('Resolved')
    const stale = db
      .prepare(`SELECT count(*) c FROM evidence_fts WHERE evidence_fts MATCH 'alpha'`)
      .get() as { c: number }
    const fresh = db
      .prepare(`SELECT count(*) c FROM evidence_fts WHERE evidence_fts MATCH 'omega'`)
      .get() as { c: number }
    expect(stale.c).toBe(0)
    expect(fresh.c).toBe(1)
  })
})
