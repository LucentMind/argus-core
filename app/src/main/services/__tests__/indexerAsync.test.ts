import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { indexEvidenceFile, indexEvidenceFileAsync, IndexAbortedError } from '../indexer'
import { sidecarPath, __clearIndexCacheForTests } from '../lineIndex'
import { MAX_READ_BYTES } from '../search'

function freshDb(): DatabaseSync {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-idxa-'))
  return openDb(path.join(dir, 'argus.db'))
}

let tmp: string, argusHome: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-idxa-tmp-'))
  argusHome = path.join(tmp, 'home')
  __clearIndexCacheForTests()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** Multi-megabyte so the read loop runs several chunks. Returns line count. */
function writeBigFile(p: string): number {
  const line = 'x'.repeat(1024) + '\n'
  const count = Math.ceil(MAX_READ_BYTES / line.length) + 100
  const fd = fs.openSync(p, 'w')
  for (let i = 0; i < count; i++) fs.writeSync(fd, line)
  fs.closeSync(fd)
  return count
}

describe('indexEvidenceFileAsync', () => {
  it('produces byte-identical FTS rows to the synchronous indexer', async () => {
    const db = freshDb()
    const p = path.join(tmp, 'parity.txt')
    fs.writeFileSync(p, Array.from({ length: 950 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')

    const syncChunks = indexEvidenceFile(db, 1, p, 400)
    const asyncChunks = await indexEvidenceFileAsync(db, 2, p, 400)
    expect(asyncChunks).toBe(syncChunks)

    const read = (id: number): unknown[] =>
      db
        .prepare(
          `SELECT chunk_index, start_line, end_line, content FROM evidence_fts
           WHERE evidence_id = ? ORDER BY chunk_index`
        )
        .all(id)
    expect(read(2)).toEqual(read(1))
  })

  it('yields to the event loop between chunks', async () => {
    const db = freshDb()
    const p = path.join(tmp, 'yield.txt')
    writeBigFile(p)

    let tickRan = false
    const indexing = indexEvidenceFileAsync(db, 3, p, 400)
    // A macrotask queued now must run BEFORE indexing settles. The synchronous
    // indexer would starve it until completion — this is the whole point of the change.
    setTimeout(() => {
      tickRan = true
    }, 0)
    await indexing
    expect(tickRan).toBe(true)
  })

  it('reports monotonic progress ending at bytesTotal', async () => {
    const db = freshDb()
    const p = path.join(tmp, 'progress.txt')
    writeBigFile(p)
    const size = fs.statSync(p).size

    const seen: number[] = []
    await indexEvidenceFileAsync(db, 4, p, 400, undefined, {
      onProgress: (done, total) => {
        expect(total).toBe(size)
        seen.push(done)
      }
    })
    expect(seen.length).toBeGreaterThan(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    expect(seen[seen.length - 1]).toBe(size)
  })

  it('writes the piggybacked sidecar for large files', async () => {
    const db = freshDb()
    const p = path.join(tmp, 'big.txt')
    const count = writeBigFile(p)
    await indexEvidenceFileAsync(db, 5, p, 400, argusHome)
    const parsed = JSON.parse(fs.readFileSync(sidecarPath(argusHome, p), 'utf8'))
    expect(parsed.totalLines).toBe(count)
  })

  it('throws IndexAbortedError and stops reading when shouldAbort flips', async () => {
    const db = freshDb()
    const p = path.join(tmp, 'abort.txt')
    writeBigFile(p)

    let calls = 0
    await expect(
      indexEvidenceFileAsync(db, 6, p, 400, undefined, {
        shouldAbort: () => ++calls > 1
      })
    ).rejects.toBeInstanceOf(IndexAbortedError)

    // Partial rows may exist; the queue is responsible for clearing them (Task 4).
    // What matters here is that the read loop stopped early rather than finishing.
    const n = db.prepare(`SELECT count(*) AS n FROM evidence_fts WHERE evidence_id = 6`).get() as {
      n: number
    }
    const full = await indexEvidenceFileAsync(db, 7, p, 400)
    expect(n.n).toBeLessThan(full)
  })
})
