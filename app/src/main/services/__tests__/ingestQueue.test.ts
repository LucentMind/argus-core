import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { IngestQueue, type EvidenceProgressEvent, type QueueProgressEvent } from '../ingestQueue'
import { readIndexState } from '../indexState'

let tmp: string, argusHome: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-queue-'))
  argusHome = path.join(tmp, 'home')
  fs.mkdirSync(argusHome, { recursive: true })
  db = openDb(path.join(tmp, 'argus.db'))
  createCase(db, argusHome, { slug: 'Q-1', title: 'queue' })
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function makeFile(name: string, lines: number): { abs: string; size: number } {
  const abs = path.join(tmp, name)
  fs.writeFileSync(abs, Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n')
  return { abs, size: fs.statSync(abs).size }
}

function insertEvidence(relPath: string, size: number): number {
  const caseId = (db.prepare(`SELECT id FROM cases WHERE slug = 'Q-1'`).get() as { id: number }).id
  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (?, ?, 'abc', 'text', ?, 'upload', '{"indexState":"pending"}', '2026-08-14T00:00:00.000Z')`
    )
    .run(caseId, relPath, size)
  return Number(res.lastInsertRowid)
}

function harness(overrides: Partial<{ extract: (id: number) => Promise<boolean> }> = {}) {
  const items: EvidenceProgressEvent[] = []
  const queues: QueueProgressEvent[] = []
  const changed: string[] = []
  let clock = 0
  const queue = new IngestQueue({
    db,
    argusHome,
    extract: overrides.extract ?? (async () => false),
    onItemProgress: (e) => items.push(e),
    onQueueProgress: (e) => queues.push(e),
    onEvidenceChanged: (s) => changed.push(s),
    // advance past both throttle windows on every read so tests see every event
    now: () => (clock += 10_000)
  })
  return { queue, items, queues, changed }
}

describe('IngestQueue', () => {
  it('indexes a queued file and marks it indexed', async () => {
    const { abs, size } = makeFile('a.txt', 500)
    const id = insertEvidence('evidence/a.txt', size)
    const { queue } = harness()

    queue.enqueue({ caseSlug: 'Q-1', evidenceId: id, absPath: abs, size })
    await queue.idle()

    const n = db
      .prepare(`SELECT count(*) AS n FROM evidence_fts WHERE evidence_id = ?`)
      .get(id) as { n: number }
    expect(n.n).toBeGreaterThan(0)
    const meta = JSON.parse(
      (db.prepare(`SELECT meta FROM evidence WHERE id = ?`).get(id) as { meta: string }).meta
    )
    expect(readIndexState(meta)).toBe('indexed')
  })

  it('runs jobs strictly one at a time', async () => {
    const a = makeFile('s1.txt', 200)
    const b = makeFile('s2.txt', 200)
    const idA = insertEvidence('evidence/s1.txt', a.size)
    const idB = insertEvidence('evidence/s2.txt', b.size)

    let concurrent = 0
    let maxConcurrent = 0
    const { queue } = harness({
      extract: async () => {
        maxConcurrent = Math.max(maxConcurrent, ++concurrent)
        await new Promise((r) => setTimeout(r, 5))
        concurrent--
        return false
      }
    })

    queue.enqueue({ caseSlug: 'Q-1', evidenceId: idA, absPath: a.abs, size: a.size })
    queue.enqueue({ caseSlug: 'Q-1', evidenceId: idB, absPath: b.abs, size: b.size })
    await queue.idle()
    expect(maxConcurrent).toBe(1)
  })

  it('emits indexing then extracting then done for one file', async () => {
    const { abs, size } = makeFile('phases.txt', 100)
    const id = insertEvidence('evidence/phases.txt', size)
    const { queue, items } = harness()

    queue.enqueue({ caseSlug: 'Q-1', evidenceId: id, absPath: abs, size })
    await queue.idle()

    const phases = items.map((e) => e.phase)
    expect(phases[0]).toBe('indexing')
    expect(phases).toContain('extracting')
    expect(phases[phases.length - 1]).toBe('done')
    expect(items[items.length - 1].fraction).toBe(1)
  })

  it('reports aggregate byte progress and zeroes the counters when drained', async () => {
    const a = makeFile('agg1.txt', 300)
    const b = makeFile('agg2.txt', 300)
    const idA = insertEvidence('evidence/agg1.txt', a.size)
    const idB = insertEvidence('evidence/agg2.txt', b.size)
    const { queue, queues } = harness()

    queue.enqueue({ caseSlug: 'Q-1', evidenceId: idA, absPath: a.abs, size: a.size })
    queue.enqueue({ caseSlug: 'Q-1', evidenceId: idB, absPath: b.abs, size: b.size })
    await queue.idle()

    expect(queues.some((q) => q.filesTotal === 2)).toBe(true)
    // After the first file finishes with a second still queued, bytesDone must equal
    // exactly that one file's size — not double it. onProgress already advances the
    // counter to completion internally, so the post-job bookkeeping in drain() must
    // not add the file's size on top of that.
    const afterFirst = queues.find((q) => q.filesDone === 1 && q.filesTotal === 2)
    expect(afterFirst?.bytesDone).toBe(a.size)
    const last = queues[queues.length - 1]
    expect(last).toEqual({
      slug: 'Q-1',
      filesDone: 0,
      filesTotal: 0,
      bytesDone: 0,
      bytesTotal: 0
    })
  })

  it('drops an aborted job and leaves no FTS rows behind', async () => {
    const { abs, size } = makeFile('gone.txt', 5000)
    const id = insertEvidence('evidence/gone.txt', size)
    const { queue } = harness()

    queue.enqueue({ caseSlug: 'Q-1', evidenceId: id, absPath: abs, size })
    queue.abort(id)
    await queue.idle()

    const n = db
      .prepare(`SELECT count(*) AS n FROM evidence_fts WHERE evidence_id = ?`)
      .get(id) as { n: number }
    expect(n.n).toBe(0)
  })

  it('marks a file errored and keeps draining when indexing throws', async () => {
    const missing = path.join(tmp, 'does-not-exist.txt')
    const idBad = insertEvidence('evidence/does-not-exist.txt', 10)
    const good = makeFile('good.txt', 100)
    const idGood = insertEvidence('evidence/good.txt', good.size)
    const { queue, items } = harness()

    queue.enqueue({ caseSlug: 'Q-1', evidenceId: idBad, absPath: missing, size: 10 })
    queue.enqueue({ caseSlug: 'Q-1', evidenceId: idGood, absPath: good.abs, size: good.size })
    await queue.idle()

    const badMeta = JSON.parse(
      (db.prepare(`SELECT meta FROM evidence WHERE id = ?`).get(idBad) as { meta: string }).meta
    )
    expect(readIndexState(badMeta)).toBe('error')
    expect(items.some((e) => e.evidenceId === idBad && e.phase === 'error')).toBe(true)

    const goodMeta = JSON.parse(
      (db.prepare(`SELECT meta FROM evidence WHERE id = ?`).get(idGood) as { meta: string }).meta
    )
    expect(readIndexState(goodMeta)).toBe('indexed')
  })

  it('fires onEvidenceChanged only when extraction produced a derived record', async () => {
    const a = makeFile('d1.txt', 50)
    const b = makeFile('d2.txt', 50)
    const idA = insertEvidence('evidence/d1.txt', a.size)
    const idB = insertEvidence('evidence/d2.txt', b.size)
    const { queue, changed } = harness({ extract: async (id) => id === idA })

    queue.enqueue({ caseSlug: 'Q-1', evidenceId: idA, absPath: a.abs, size: a.size })
    queue.enqueue({ caseSlug: 'Q-1', evidenceId: idB, absPath: b.abs, size: b.size })
    await queue.idle()

    expect(changed.filter((s) => s === 'Q-1').length).toBe(1)
  })

  it('throttles item progress to one event per 100ms of wall clock', async () => {
    const big = path.join(tmp, 'throttle.txt')
    const line = 'y'.repeat(1024) + '\n'
    const fd = fs.openSync(big, 'w')
    for (let i = 0; i < 8000; i++) fs.writeSync(fd, line)
    fs.closeSync(fd)
    const size = fs.statSync(big).size
    const id = insertEvidence('evidence/throttle.txt', size)

    const items: EvidenceProgressEvent[] = []
    const queue = new IngestQueue({
      db,
      argusHome,
      extract: async () => false,
      onItemProgress: (e) => items.push(e),
      onQueueProgress: () => {},
      onEvidenceChanged: () => {},
      now: () => 0 // clock never advances: only unthrottleable events get through
    })
    queue.enqueue({ caseSlug: 'Q-1', evidenceId: id, absPath: big, size })
    await queue.idle()

    // phase changes and terminals only — no per-chunk flood
    expect(items.map((e) => e.phase)).toEqual(['indexing', 'extracting', 'done'])
  })
})
