import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact, ingestContent, deleteEvidence } from '../ingest'
import { readIndexState } from '../indexState'
import type { IngestJob, IngestQueueLike } from '../ingestQueue'
import { createDetection } from '../packs/detection'
import { samplePackRegistry } from '../packs/__tests__/fixtures'

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

  it('marks a non-indexable artifact skipped and enqueues nothing', async () => {
    const q = recordingQueue()
    const src = path.join(tmp, 'shot.png')
    fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const rec = await ingestArtifact(db, argusHome, detection, q, 'IQ-1', src)

    expect(readIndexState(rec.meta)).toBe('skipped')
    expect(q.jobs).toHaveLength(0)
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
