import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { indexEvidenceText } from '../indexer'
import { searchEvidenceWithStatus } from '../search'

let tmp: string, argusHome: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-spend-'))
  argusHome = path.join(tmp, 'home')
  fs.mkdirSync(argusHome, { recursive: true })
  db = openDb(path.join(tmp, 'argus.db'))
  createCase(db, argusHome, { slug: 'SP-1', title: 'pending' })
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function insert(relPath: string, indexState: string): number {
  const caseId = (db.prepare(`SELECT id FROM cases WHERE slug = 'SP-1'`).get() as { id: number }).id
  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (?, ?, 'abc', 'text', 5, 'upload', ?, '2026-08-14T00:00:00.000Z')`
    )
    .run(caseId, relPath, JSON.stringify({ indexState }))
  return Number(res.lastInsertRowid)
}

describe('searchEvidenceWithStatus', () => {
  it('reports how many of the case files are still unindexed', () => {
    const done = insert('evidence/done.txt', 'indexed')
    indexEvidenceText(db, done, 'TileStore failure here\n', 400)
    insert('evidence/waiting.txt', 'pending')
    insert('evidence/running.txt', 'indexing')

    const res = searchEvidenceWithStatus(db, argusHome, 'TileStore', { caseSlug: 'SP-1' })
    expect(res.hits).toHaveLength(1)
    expect(res.pendingIndexCount).toBe(2)
  })

  it('reports zero once everything is indexed', () => {
    const done = insert('evidence/all.txt', 'indexed')
    indexEvidenceText(db, done, 'TileStore failure here\n', 400)
    const res = searchEvidenceWithStatus(db, argusHome, 'TileStore', { caseSlug: 'SP-1' })
    expect(res.pendingIndexCount).toBe(0)
  })

  it('still reports pending files when the query matches nothing yet', () => {
    insert('evidence/waiting.txt', 'pending')
    const res = searchEvidenceWithStatus(db, argusHome, 'TileStore', { caseSlug: 'SP-1' })
    expect(res.hits).toHaveLength(0)
    expect(res.pendingIndexCount).toBe(1)
  })
})
