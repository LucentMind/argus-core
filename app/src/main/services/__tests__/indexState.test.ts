import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import {
  setIndexState,
  readIndexState,
  listPendingIndexEvidence,
  countPendingIndex
} from '../indexState'

let tmp: string, argusHome: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-istate-'))
  argusHome = path.join(tmp, 'home')
  fs.mkdirSync(argusHome, { recursive: true })
  db = openDb(path.join(tmp, 'argus.db'))
  createCase(db, argusHome, { slug: 'IS-1', title: 'state' })
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function insertEvidence(meta: Record<string, unknown>, size = 10): number {
  const caseId = (db.prepare(`SELECT id FROM cases WHERE slug = 'IS-1'`).get() as { id: number }).id
  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (?, ?, 'abc', 'text', ?, 'upload', ?, '2026-08-14T00:00:00.000Z')`
    )
    .run(caseId, `evidence/f${Math.random()}.txt`, size, JSON.stringify(meta))
  return Number(res.lastInsertRowid)
}

describe('readIndexState', () => {
  it('returns the explicit state when present', () => {
    expect(readIndexState({ indexState: 'indexing' })).toBe('indexing')
  })

  it('falls back to the legacy indexed boolean', () => {
    expect(readIndexState({ indexed: true })).toBe('indexed')
    expect(readIndexState({ indexed: false })).toBe('skipped')
  })

  it('treats a row with neither field as skipped', () => {
    expect(readIndexState({})).toBe('skipped')
  })
})

describe('setIndexState', () => {
  it('updates only indexState and preserves the rest of meta', () => {
    const id = insertEvidence({ originalName: 'a.txt', indexState: 'pending' })
    setIndexState(db, id, 'indexed')
    const row = db.prepare(`SELECT meta FROM evidence WHERE id = ?`).get(id) as { meta: string }
    expect(JSON.parse(row.meta)).toEqual({ originalName: 'a.txt', indexState: 'indexed' })
  })
})

describe('listPendingIndexEvidence', () => {
  it('returns pending and indexing rows with their case slug, and nothing else', () => {
    const pending = insertEvidence({ indexState: 'pending' }, 111)
    const indexing = insertEvidence({ indexState: 'indexing' }, 222)
    insertEvidence({ indexState: 'indexed' })
    insertEvidence({ indexState: 'skipped' })
    insertEvidence({ indexState: 'error' })

    const rows = listPendingIndexEvidence(db)
    expect(rows.map((r) => r.id).sort()).toEqual([pending, indexing].sort())
    expect(rows.every((r) => r.caseSlug === 'IS-1')).toBe(true)
    expect(rows.find((r) => r.id === pending)?.size).toBe(111)
  })
})

describe('countPendingIndex', () => {
  it('counts pending and indexing rows for one case', () => {
    insertEvidence({ indexState: 'pending' })
    insertEvidence({ indexState: 'indexing' })
    insertEvidence({ indexState: 'indexed' })
    expect(countPendingIndex(db, 'IS-1')).toBe(2)
    expect(countPendingIndex(db, 'NOPE')).toBe(0)
  })

  it('counts across all cases when caseSlug is null', () => {
    insertEvidence({ indexState: 'pending' })
    expect(countPendingIndex(db, null)).toBe(1)
  })
})
