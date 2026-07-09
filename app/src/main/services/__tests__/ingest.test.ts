import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact, listEvidence } from '../ingest'
import type { DatabaseSync } from 'node:sqlite'

const FIXTURE = path.resolve(__dirname, '../../../../../tests/fixtures/sample-applog.txt')

let home: string
let db: DatabaseSync

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ing-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'NAVAPI-1', title: 'test' })
})

describe('ingestArtifact', () => {
  it('copies, hashes, types, and indexes a applog', () => {
    const rec = ingestArtifact(db, home, 'NAVAPI-1', FIXTURE)
    expect(rec.artifactType).toBe('applog')
    expect(rec.relPath).toBe('evidence/sample-applog.txt')
    expect(rec.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.existsSync(path.join(home, 'cases/NAVAPI-1', rec.relPath))).toBe(true)
    expect(fs.existsSync(path.join(home, 'cases/NAVAPI-1/evidence/.meta/sample-applog.txt.json'))).toBe(true)
    const hit = db
      .prepare(`SELECT evidence_id FROM evidence_fts WHERE evidence_fts MATCH ?`)
      .get('"TileStore error"') as { evidence_id: number } | undefined
    expect(hit?.evidence_id).toBe(rec.id)
  })

  it('suffixes filename collisions', () => {
    const a = ingestArtifact(db, home, 'NAVAPI-1', FIXTURE)
    const b = ingestArtifact(db, home, 'NAVAPI-1', FIXTURE)
    expect(a.relPath).toBe('evidence/sample-applog.txt')
    expect(b.relPath).toBe('evidence/sample-applog-1.txt')
  })

  it('throws for unknown case', () => {
    expect(() => ingestArtifact(db, home, 'NOPE-1', FIXTURE)).toThrow(/case/i)
  })

  it('lists evidence for a case', () => {
    ingestArtifact(db, home, 'NAVAPI-1', FIXTURE)
    const all = listEvidence(db, 'NAVAPI-1')
    expect(all).toHaveLength(1)
    expect(all[0].artifactType).toBe('applog')
  })
})
