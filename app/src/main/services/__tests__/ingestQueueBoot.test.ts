import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { caseDir } from '../paths'
import { requeuePendingIndexes, type IngestJob, type IngestQueueLike } from '../ingestQueue'

let tmp: string, argusHome: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-boot-'))
  argusHome = path.join(tmp, 'home')
  fs.mkdirSync(argusHome, { recursive: true })
  db = openDb(path.join(tmp, 'argus.db'))
  createCase(db, argusHome, { slug: 'B-1', title: 'boot' })
})
afterEach(() => {
  // Windows keeps the .db file locked while the handle is open; rmSync would EBUSY.
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function insert(relPath: string, indexState: string): number {
  const caseId = (db.prepare(`SELECT id FROM cases WHERE slug = 'B-1'`).get() as { id: number }).id
  const abs = path.join(caseDir(argusHome, 'B-1'), ...relPath.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, 'data\n')
  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (?, ?, 'abc', 'text', 5, 'upload', ?, '2026-08-14T00:00:00.000Z')`
    )
    .run(caseId, relPath, JSON.stringify({ indexState }))
  return Number(res.lastInsertRowid)
}

function recordingQueue(): IngestQueueLike & { jobs: IngestJob[] } {
  const jobs: IngestJob[] = []
  return { jobs, enqueue: (j) => jobs.push(j), abort: () => {} }
}

describe('requeuePendingIndexes', () => {
  it('re-enqueues rows left pending or indexing by a crash', () => {
    const pending = insert('evidence/p.txt', 'pending')
    const indexing = insert('evidence/i.txt', 'indexing')
    insert('evidence/done.txt', 'indexed')
    const q = recordingQueue()

    expect(requeuePendingIndexes(db, argusHome, q)).toBe(2)
    expect(q.jobs.map((j) => j.evidenceId).sort()).toEqual([pending, indexing].sort())
    expect(q.jobs.every((j) => fs.existsSync(j.absPath))).toBe(true)
    // These rows were pending BECAUSE they are indexable; phase 1 must not be skipped.
    expect(q.jobs.every((j) => j.index)).toBe(true)
  })

  it('skips rows whose file has disappeared rather than queueing a doomed job', () => {
    const id = insert('evidence/ghost.txt', 'pending')
    fs.rmSync(path.join(caseDir(argusHome, 'B-1'), 'evidence', 'ghost.txt'))
    const q = recordingQueue()

    expect(requeuePendingIndexes(db, argusHome, q)).toBe(0)
    expect(q.jobs).toHaveLength(0)
    const meta = JSON.parse(
      (db.prepare(`SELECT meta FROM evidence WHERE id = ?`).get(id) as { meta: string }).meta
    )
    expect(meta.indexState).toBe('error')
  })

  // 'error' is otherwise a terminal sink: nothing transitions a row out of it, the
  // pending predicate does not match it, and rescanModified only fires when the file's
  // sha256 CHANGES. A transiently absent file (unmounted share, external drive, sync
  // client mid-restore) would therefore be permanently unsearchable after one unlucky
  // restart. Boot is the natural place to reconsider.
  it('re-enqueues an errored row whose file has reappeared', () => {
    const id = insert('evidence/back.txt', 'error')
    const q = recordingQueue()

    expect(requeuePendingIndexes(db, argusHome, q)).toBe(1)
    expect(q.jobs.map((j) => j.evidenceId)).toEqual([id])
    expect(q.jobs[0].index).toBe(true)
    const meta = JSON.parse(
      (db.prepare(`SELECT meta FROM evidence WHERE id = ?`).get(id) as { meta: string }).meta
    )
    // Back in the lifecycle, so countPendingIndex sees it and the bar has a denominator.
    expect(meta.indexState).toBe('pending')
  })

  it('leaves an errored row alone while its file is still missing', () => {
    const id = insert('evidence/still-gone.txt', 'error')
    fs.rmSync(path.join(caseDir(argusHome, 'B-1'), 'evidence', 'still-gone.txt'))
    const q = recordingQueue()

    expect(requeuePendingIndexes(db, argusHome, q)).toBe(0)
    expect(q.jobs).toHaveLength(0)
    const meta = JSON.parse(
      (db.prepare(`SELECT meta FROM evidence WHERE id = ?`).get(id) as { meta: string }).meta
    )
    expect(meta.indexState).toBe('error')
  })
})
