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

function countFts(evidenceId: number): number {
  return (
    db.prepare(`SELECT count(*) AS n FROM evidence_fts WHERE evidence_id = ?`).get(evidenceId) as {
      n: number
    }
  ).n
}

function indexStateOf(evidenceId: number): string | undefined {
  const meta = JSON.parse(
    (db.prepare(`SELECT meta FROM evidence WHERE id = ?`).get(evidenceId) as { meta: string }).meta
  )
  return readIndexState(meta)
}

/** A promise plus its resolver, for parking a job inside `extract`. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}

interface Harness {
  queue: IngestQueue
  items: EvidenceProgressEvent[]
  queues: QueueProgressEvent[]
  changed: string[]
}

function harness(
  overrides: Partial<{
    extract: (id: number) => Promise<boolean>
    onItem: (e: EvidenceProgressEvent) => void
  }> = {}
): Harness {
  const items: EvidenceProgressEvent[] = []
  const queues: QueueProgressEvent[] = []
  const changed: string[] = []
  let clock = 0
  const queue = new IngestQueue({
    db,
    argusHome,
    extract: overrides.extract ?? (async () => false),
    onItemProgress: (e) => {
      items.push(e)
      overrides.onItem?.(e)
    },
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

  it('deletes the partial index when an abort lands after a chunk was already flushed', async () => {
    // >1MB (the indexer's read chunk) so at least one full read — and the 400-line
    // FTS chunks it produced — completes before the abort is raised. Aborting
    // before the first read proves nothing: there would be nothing to clean up.
    const big = path.join(tmp, 'abort-mid.txt')
    const line = 'z'.repeat(1023) + '\n'
    const fd = fs.openSync(big, 'w')
    for (let i = 0; i < 3000; i++) fs.writeSync(fd, line)
    fs.closeSync(fd)
    const size = fs.statSync(big).size
    const id = insertEvidence('evidence/abort-mid.txt', size)

    let rowsWhenAborted = -1
    const { queue } = harness({
      onItem: (e) => {
        if (rowsWhenAborted < 0 && e.phase === 'indexing' && e.fraction > 0) {
          rowsWhenAborted = countFts(id)
          queue.abort(id)
        }
      }
    })

    queue.enqueue({ caseSlug: 'Q-1', evidenceId: id, absPath: big, size })
    await queue.idle()

    expect(rowsWhenAborted).toBeGreaterThan(0) // a partial index really existed
    expect(countFts(id)).toBe(0) // ...and the abort path removed it
    expect(indexStateOf(id)).toBe('pending') // not stranded at 'indexing'
  })

  it('undoes the index when the abort loses the race with the last chunk', async () => {
    const { abs, size } = makeFile('late-abort.txt', 400)
    const id = insertEvidence('evidence/late-abort.txt', size)

    // The file is under one read chunk, so the loop emits progress once and the
    // indexer emits a final completion progress after the loop has exited and the
    // writer has flushed. Aborting on that second event lands too late for
    // shouldAbort to ever be consulted again.
    let fullProgress = 0
    let extractCalls = 0
    const { queue, items } = harness({
      extract: async () => {
        extractCalls++
        return false
      },
      onItem: (e) => {
        if (e.phase === 'indexing' && e.fraction === 1 && ++fullProgress === 2) queue.abort(id)
      }
    })

    queue.enqueue({ caseSlug: 'Q-1', evidenceId: id, absPath: abs, size })
    await queue.idle()

    expect(fullProgress).toBeGreaterThanOrEqual(2) // the abort really did land late
    expect(countFts(id)).toBe(0)
    expect(indexStateOf(id)).toBe('pending')
    expect(extractCalls).toBe(0)
    expect(items.some((e) => e.phase === 'extracting' || e.phase === 'done')).toBe(false)
  })

  it('drops a job aborted while it is still queued behind a running one', async () => {
    const a = makeFile('q-a.txt', 100)
    const b = makeFile('q-b.txt', 100)
    const idA = insertEvidence('evidence/q-a.txt', a.size)
    const idB = insertEvidence('evidence/q-b.txt', b.size)

    const g = gate()
    const entered = gate()
    const { queue, items } = harness({
      extract: async (id) => {
        if (id === idA) {
          entered.open()
          await g.promise
        }
        return false
      }
    })

    queue.enqueue({ caseSlug: 'Q-1', evidenceId: idA, absPath: a.abs, size: a.size })
    queue.enqueue({ caseSlug: 'Q-1', evidenceId: idB, absPath: b.abs, size: b.size })
    await entered.promise // A is parked in extract, so B is genuinely still queued
    queue.abort(idB)
    g.open()
    await queue.idle()

    expect(countFts(idB)).toBe(0)
    expect(indexStateOf(idB)).toBe('pending') // the row was never touched
    expect(items.some((e) => e.evidenceId === idB)).toBe(false)

    // The flag is consumed by the job it belonged to, so it does not leak into a
    // later enqueue of the same evidence id.
    queue.enqueue({ caseSlug: 'Q-1', evidenceId: idB, absPath: b.abs, size: b.size })
    await queue.idle()
    expect(countFts(idB)).toBeGreaterThan(0)
  })

  it('runs a job enqueued in the microtask window where a drain is settling', async () => {
    // There is a tick where drain() has already returned but the reaction that
    // clears the running latch has not run yet. A job enqueued exactly then sees
    // a truthy latch, starts no drain, and is stranded forever while idle()
    // still resolves. A real ingest loop (`await copy(f); queue.enqueue(...)`)
    // lands in that gap.
    //
    // Which microtask it is depends on how many awaits the queue's own job path
    // contains, so it moves whenever that path changes — pinning a single depth
    // is how this test silently stopped detecting the defect once. Sweep instead:
    // every depth in the range must end up indexed, so the window is caught
    // wherever it currently sits.
    const settled: Array<{ depth: number; indexed: boolean }> = []

    for (let depth = 0; depth <= 6; depth++) {
      const a = makeFile(`kick-${depth}a.txt`, 40)
      const b = makeFile(`kick-${depth}b.txt`, 40)
      const idA = insertEvidence(`evidence/kick-${depth}a.txt`, a.size)
      const idB = insertEvidence(`evidence/kick-${depth}b.txt`, b.size)

      const g = gate()
      const entered = gate()
      const { queue } = harness({
        extract: async (id) => {
          if (id === idA) {
            entered.open()
            await g.promise
          }
          return false
        }
      })

      queue.enqueue({ caseSlug: 'Q-1', evidenceId: idA, absPath: a.abs, size: a.size })
      await entered.promise

      let chain: Promise<void> = g.promise
      for (let i = 0; i < depth; i++) chain = chain.then(() => {})
      const late = chain.then(() =>
        queue.enqueue({ caseSlug: 'Q-1', evidenceId: idB, absPath: b.abs, size: b.size })
      )
      g.open()
      await late
      await queue.idle()

      settled.push({ depth, indexed: countFts(idB) > 0 && indexStateOf(idB) === 'indexed' })
    }

    expect(settled.filter((s) => !s.indexed)).toEqual([])
  })

  it('honours an abort that arrives before the job is enqueued', async () => {
    // Ingest inserts the evidence row and only then enqueues, so a delete can
    // land in between and abort an id the queue has never seen.
    const { abs, size } = makeFile('pre-abort.txt', 200)
    const id = insertEvidence('evidence/pre-abort.txt', size)
    const { queue, items } = harness()

    queue.abort(id)
    queue.enqueue({ caseSlug: 'Q-1', evidenceId: id, absPath: abs, size })
    await queue.idle()

    expect(countFts(id)).toBe(0)
    expect(indexStateOf(id)).toBe('pending')
    expect(items.some((e) => e.evidenceId === id)).toBe(false)

    // ...and the flag does not outlive the drain that consumed it.
    queue.enqueue({ caseSlug: 'Q-1', evidenceId: id, absPath: abs, size })
    await queue.idle()
    expect(countFts(id)).toBeGreaterThan(0)
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
