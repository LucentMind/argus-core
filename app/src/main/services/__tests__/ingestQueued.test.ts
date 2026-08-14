import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact, ingestContent, deleteEvidence, listEvidence } from '../ingest'
import { extractDerivedText } from '../extraction'
import { readIndexState } from '../indexState'
import { IngestQueue, type IngestJob, type IngestQueueLike } from '../ingestQueue'
import { createDetection } from '../packs/detection'
import { samplePackRegistry, stubExtractors } from '../packs/__tests__/fixtures'

const detection = createDetection(samplePackRegistry())

let tmp: string, argusHome: string, db: DatabaseSync

function recordingQueue(): IngestQueueLike & { jobs: IngestJob[]; abortedIds: number[] } {
  const jobs: IngestJob[] = []
  const abortedIds: number[] = []
  return {
    jobs,
    abortedIds,
    enqueue: (j) => jobs.push(j),
    abort: (id) => abortedIds.push(id)
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ingq-'))
  argusHome = path.join(tmp, 'home')
  fs.mkdirSync(argusHome, { recursive: true })
  db = openDb(path.join(tmp, 'argus.db'))
  createCase(db, argusHome, { slug: 'IQ-1', title: 'queued' })
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('ingest enqueues instead of indexing inline', () => {
  it('ingestArtifact returns a pending record and writes no FTS rows yet', async () => {
    const q = recordingQueue()
    const src = path.join(tmp, 'trace.txt')
    fs.writeFileSync(src, 'alpha\nbeta\n')

    const rec = await ingestArtifact(db, argusHome, detection, q, 'IQ-1', src)

    expect(readIndexState(rec.meta)).toBe('pending')
    const n = db
      .prepare(`SELECT count(*) AS n FROM evidence_fts WHERE evidence_id = ?`)
      .get(rec.id) as { n: number }
    expect(n.n).toBe(0)
    expect(q.jobs).toHaveLength(1)
    expect(q.jobs[0]).toMatchObject({ caseSlug: 'IQ-1', evidenceId: rec.id })
    expect(fs.existsSync(q.jobs[0].absPath)).toBe(true)
  })

  it('marks a non-indexable artifact skipped but still enqueues it for extraction', async () => {
    const q = recordingQueue()
    const src = path.join(tmp, 'shot.png')
    fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const rec = await ingestArtifact(db, argusHome, detection, q, 'IQ-1', src)

    expect(readIndexState(rec.meta)).toBe('skipped')
    // Enqueued anyway, with index:false — phase 2 (extraction) is the whole point for
    // a binary artifact. Gating the enqueue on indexability would silently kill it.
    expect(q.jobs).toHaveLength(1)
    expect(q.jobs[0]).toMatchObject({ evidenceId: rec.id, index: false })
  })

  it('a non-indexable artifact with a declared extractor still produces a derived record', async () => {
    // End-to-end through the REAL queue: ingest a .binlog (isText === false, so nothing
    // to index) whose pack declares an extract command, and assert derived text lands.
    const extractors = stubExtractors('binlog')
    const changed: string[] = []
    // NOTE: this test fixture's `extract` callback intentionally omits the
    // `meta.derivedFrom` recursion guard that main/index.ts's real callback has (see the
    // comment above `if (rec.meta.derivedFrom !== undefined) return false` there, and
    // main/__tests__/extractDerivedFromGuard.test.ts which pins it). It is safe HERE only
    // because `binlog` is the sole pack fixture with an extract command and derived text is
    // never re-classified as `binlog`, so this fixture never recurses. Do not copy this
    // shape into production code — production needs the guard because a pack declaring an
    // extract command for the derived `text` artifact type would otherwise recurse forever.
    const queue = new IngestQueue({
      db,
      argusHome,
      extract: async (evidenceId) => {
        const rec = listEvidence(db, 'IQ-1', 'all').find((e) => e.id === evidenceId)
        if (!rec) return false
        return (await extractDerivedText(db, argusHome, queue, rec, extractors)) !== null
      },
      onItemProgress: () => {},
      onQueueProgress: () => {},
      onEvidenceChanged: (s) => changed.push(s)
    })

    const src = path.join(tmp, 'trace.binlog')
    fs.writeFileSync(src, 'ECU1 TunnelExit bearing jump detected\n')
    const rec = await ingestArtifact(db, argusHome, detection, queue, 'IQ-1', src)
    expect(readIndexState(rec.meta)).toBe('skipped')

    await queue.idle()

    const derived = listEvidence(db, 'IQ-1', 'all').filter((e) => e.meta.derivedFrom === rec.id)
    expect(derived).toHaveLength(1)
    expect(changed).toContain('IQ-1')
    // the derived text IS indexable, so the queue indexed it in its own job
    const n = db
      .prepare(`SELECT count(*) AS n FROM evidence_fts WHERE evidence_id = ?`)
      .get(derived[0].id) as { n: number }
    expect(n.n).toBeGreaterThan(0)
  })

  it('ingestContent enqueues the written file with its real size', () => {
    const q = recordingQueue()
    const body = 'one\ntwo\nthree\n'

    const rec = ingestContent(db, argusHome, detection, q, 'IQ-1', 'notes.txt', body, 'upload')

    expect(readIndexState(rec.meta)).toBe('pending')
    expect(q.jobs[0].size).toBe(Buffer.byteLength(body))
  })

  it('aborts every doomed id before the rows are deleted', async () => {
    const q = recordingQueue()
    const src = path.join(tmp, 'parent.txt')
    fs.writeFileSync(src, 'parent\n')
    const parent = await ingestArtifact(db, argusHome, detection, q, 'IQ-1', src)

    // an id aborted here must have been aborted while its row still existed
    const seenWhenAborted: boolean[] = []
    const abortingQueue: IngestQueueLike = {
      enqueue: () => {},
      abort: (id) => {
        const row = db.prepare(`SELECT id FROM evidence WHERE id = ?`).get(id)
        seenWhenAborted.push(row !== undefined)
      }
    }

    deleteEvidence(db, argusHome, abortingQueue, 'IQ-1', parent.id)

    expect(seenWhenAborted).toEqual([true])
  })
})
