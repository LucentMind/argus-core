import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import {
  indexEvidenceText,
  indexEvidenceFile,
  FtsChunkWriter,
  CheckpointRecorder
} from '../indexer'
import { sidecarPath, ensureIndex, __clearIndexCacheForTests } from '../lineIndex'
import { MAX_READ_BYTES } from '../search'
import type { DatabaseSync } from 'node:sqlite'
import { createLegacyEvidenceFts } from './legacyFts'

function freshDb(): DatabaseSync {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-idx-'))
  return openDb(path.join(dir, 'argus.db'))
}

let tmp: string, argusHome: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-idx-tmp-'))
  argusHome = path.join(tmp, 'home')
  __clearIndexCacheForTests()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function writeBigFile(p: string): number {
  const line = 'x'.repeat(1024) + '\n' // 1025 bytes
  const count = Math.ceil(MAX_READ_BYTES / line.length) + 100
  const fd = fs.openSync(p, 'w')
  for (let i = 0; i < count; i++) fs.writeSync(fd, line)
  fs.closeSync(fd)
  return count
}

describe('indexEvidenceText', () => {
  it('chunks by line count with correct line ranges', () => {
    const db = freshDb()
    const text = Array.from({ length: 950 }, (_, i) => `line ${i + 1}`).join('\n')
    const chunks = indexEvidenceText(db, 7, text, 400)
    expect(chunks).toBe(3)
    const rows = db
      .prepare(
        `SELECT chunk_index, start_line, end_line FROM evidence_index_map WHERE evidence_id = 7 ORDER BY chunk_index`
      )
      .all() as { chunk_index: number; start_line: number; end_line: number }[]
    expect(rows).toEqual([
      { chunk_index: 0, start_line: 1, end_line: 400 },
      { chunk_index: 1, start_line: 401, end_line: 800 },
      { chunk_index: 2, start_line: 801, end_line: 950 }
    ])
  })

  it('is searchable via evidence_index', () => {
    const db = freshDb()
    indexEvidenceText(db, 3, 'alpha beta\ngamma TileStore error here\n', 400)
    const hit = db
      .prepare(
        `SELECT m.evidence_id AS evidenceId FROM evidence_index
         JOIN evidence_index_map m ON m.fts_rowid = evidence_index.rowid
         WHERE evidence_index MATCH ?`
      )
      .get('"TileStore error"') as { evidenceId: number } | undefined
    expect(hit?.evidenceId).toBe(3)
  })
})

describe('indexEvidenceFile', () => {
  it('writes a line-index sidecar for large files during the FTS pass', () => {
    const db = freshDb()
    const p = path.join(tmp, 'big.txt')
    const count = writeBigFile(p)

    indexEvidenceFile(db, 1, p, 400, argusHome)
    const side = sidecarPath(argusHome, p)
    expect(fs.existsSync(side)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(side, 'utf8'))
    expect(parsed.totalLines).toBe(count)
  })

  it('does not write a sidecar for small files or when argusHome is omitted', () => {
    const db = freshDb()
    const p = path.join(tmp, 'small.txt')
    fs.writeFileSync(p, 'a\nb\n')
    indexEvidenceFile(db, 2, p, 400, argusHome)
    expect(fs.existsSync(sidecarPath(argusHome, p))).toBe(false)
    indexEvidenceFile(db, 3, p) // legacy signature still works
  })

  it('produces FTS chunk rows identical to before the LineSplitter refactor', () => {
    const db = freshDb()
    const text = Array.from({ length: 950 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const p = path.join(tmp, 'chunks.txt')
    fs.writeFileSync(p, text)
    const chunks = indexEvidenceFile(db, 9, p, 400)
    expect(chunks).toBe(3)
    const rows = db
      .prepare(
        `SELECT chunk_index, start_line, end_line FROM evidence_index_map WHERE evidence_id = 9 ORDER BY chunk_index`
      )
      .all() as { chunk_index: number; start_line: number; end_line: number }[]
    expect(rows).toEqual([
      { chunk_index: 0, start_line: 1, end_line: 400 },
      { chunk_index: 1, start_line: 401, end_line: 800 },
      { chunk_index: 2, start_line: 801, end_line: 950 }
    ])
  })

  it('piggybacked sidecar is loadable by ensureIndex without a rebuild', async () => {
    const db = freshDb()
    const p = path.join(tmp, 'big2.txt')
    writeBigFile(p)

    indexEvidenceFile(db, 5, p, 400, argusHome)
    const side = sidecarPath(argusHome, p)
    const before = JSON.parse(fs.readFileSync(side, 'utf8')) as {
      mtimeMs: number
      size: number
      totalLines: number
      checkpoints: Array<[number, number]>
    }
    const sideMtimeBefore = fs.statSync(side).mtimeMs

    __clearIndexCacheForTests()
    const idx = await ensureIndex(argusHome, p)

    // Same values as the piggybacked sidecar...
    expect(idx.totalLines).toBe(before.totalLines)
    expect(idx.checkpoints).toEqual(before.checkpoints)
    expect(idx.mtimeMs).toBe(before.mtimeMs)
    expect(idx.size).toBe(before.size)
    // ...and no rebuild happened: buildIndex only rewrites the sidecar on a
    // cache miss, so an unchanged mtime proves loadSidecar succeeded.
    expect(fs.statSync(side).mtimeMs).toBe(sideMtimeBefore)
  })
})

describe('FtsChunkWriter', () => {
  it('flushes a chunk every chunkLines and tracks line ranges', () => {
    const db = freshDb()
    const w = new FtsChunkWriter(db, 42, 3)
    for (let i = 1; i <= 7; i++) w.add(`line ${i}`, i)
    w.flush()
    expect(w.chunkCount).toBe(3)
    const rows = db
      .prepare(
        `SELECT chunk_index, start_line, end_line FROM evidence_index_map WHERE evidence_id = 42 ORDER BY chunk_index`
      )
      .all() as { chunk_index: number; start_line: number; end_line: number }[]
    expect(rows).toEqual([
      { chunk_index: 0, start_line: 1, end_line: 3 },
      { chunk_index: 1, start_line: 4, end_line: 6 },
      { chunk_index: 2, start_line: 7, end_line: 7 }
    ])
  })

  it('writes an evidence_index_map row for every chunk', () => {
    const db = freshDb()
    const w = new FtsChunkWriter(db, 43, 2)
    for (let i = 1; i <= 4; i++) w.add(`x${i}`, i)
    w.flush()
    const n = db
      .prepare(`SELECT count(*) AS n FROM evidence_index_map WHERE evidence_id = 43`)
      .get() as { n: number }
    expect(n.n).toBe(2)
  })

  it('flush on an empty writer inserts nothing', () => {
    const db = freshDb()
    const w = new FtsChunkWriter(db, 44, 400)
    w.flush()
    expect(w.chunkCount).toBe(0)
  })
})

describe('contentless evidence_index', () => {
  it('writes content to evidence_index and locators to evidence_index_map', () => {
    const db = freshDb()
    indexEvidenceText(db, 100, 'alpha beta\ngamma delta\n', 1)

    const rows = db
      .prepare(
        `SELECT fts_rowid, evidence_id, chunk_index, start_line, end_line
         FROM evidence_index_map ORDER BY chunk_index`
      )
      .all() as unknown as {
      fts_rowid: number
      evidence_id: number
      chunk_index: number
      start_line: number
      end_line: number
    }[]

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ evidence_id: 100, chunk_index: 0, start_line: 1, end_line: 1 })
    expect(rows[1]).toMatchObject({ evidence_id: 100, chunk_index: 1, start_line: 2, end_line: 2 })

    const hit = db
      .prepare(`SELECT rowid FROM evidence_index WHERE evidence_index MATCH ?`)
      .all('gamma') as unknown as { rowid: number }[]
    expect(hit).toHaveLength(1)
    expect(hit[0].rowid).toBe(rows[1].fts_rowid)
  })

  it('supports phrase queries, which detail=column would have broken', () => {
    const db = freshDb()
    indexEvidenceText(db, 101, 'connection refused by peer\nrefused a connection later\n', 400)

    const phrase = db
      .prepare(`SELECT rowid FROM evidence_index WHERE evidence_index MATCH ?`)
      .all('"connection refused"') as unknown as { rowid: number }[]
    expect(phrase).toHaveLength(1)
  })

  // detail=full is retained specifically so phrase AND NEAR queries keep working;
  // detail=column and detail=none both raise on them. The phrase case above guards half
  // of that -- this guards the other half, positively and negatively, so a NEAR that had
  // silently stopped discriminating distance would fail here too.
  it('supports NEAR queries, which detail=column would have broken', () => {
    const db = freshDb()
    indexEvidenceText(db, 103, 'alpha one two three four five six seven omega\n', 400)

    const near = db
      .prepare(`SELECT rowid FROM evidence_index WHERE evidence_index MATCH ?`)
      .all('NEAR(alpha omega, 10)') as unknown as { rowid: number }[]
    expect(near).toHaveLength(1)

    const tooFar = db
      .prepare(`SELECT rowid FROM evidence_index WHERE evidence_index MATCH ?`)
      .all('NEAR(alpha omega, 2)') as unknown as { rowid: number }[]
    expect(tooFar).toHaveLength(0)
  })

  it('writes nothing to the legacy evidence_fts table, even where one still exists', () => {
    const db = freshDb()
    // A fresh database has no legacy table at all (db.ts stopped declaring it), so build
    // the pre-migration shape explicitly -- otherwise this asserts nothing more than that
    // the table is absent, which db.test.ts already covers.
    createLegacyEvidenceFts(db)
    indexEvidenceText(db, 102, 'alpha\n', 400)
    const legacy = db.prepare(`SELECT count(*) AS n FROM evidence_fts`).get() as { n: number }
    expect(legacy.n).toBe(0)
    // and the write did land, in the current generation
    expect(
      (db.prepare(`SELECT count(*) AS n FROM evidence_index_map`).get() as { n: number }).n
    ).toBe(1)
  })

  it('leaves no FTS row without its map row when the map insert throws', () => {
    const db = freshDb()
    // Force the map insert to fail on the second chunk: a NOT NULL violation inside the
    // savepoint must roll the FTS row back with it.
    db.exec(`DROP TABLE evidence_index_map`)
    db.exec(`CREATE TABLE evidence_index_map (
      fts_rowid INTEGER PRIMARY KEY, evidence_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL, start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL CHECK (end_line < 2))`)

    expect(() => indexEvidenceText(db, 103, 'a\nb\n', 1)).toThrow()

    const orphans = db
      .prepare(
        `SELECT count(*) AS n FROM evidence_index
         WHERE rowid NOT IN (SELECT fts_rowid FROM evidence_index_map)`
      )
      .get() as { n: number }
    expect(orphans.n).toBe(0)
  })
})

describe('CheckpointRecorder', () => {
  it('always starts at line 1 byte 0 and adds one per CHECKPOINT_LINES', () => {
    const r = new CheckpointRecorder(true)
    for (let i = 1; i <= 100_000; i++) r.record(i, i * 10)
    expect(r.checkpoints[0]).toEqual([1, 0])
    expect(r.checkpoints.length).toBeGreaterThan(1)
    // strictly increasing in both dimensions — lineIndex.loadSidecar rejects otherwise
    for (let i = 1; i < r.checkpoints.length; i++) {
      expect(r.checkpoints[i][0]).toBeGreaterThan(r.checkpoints[i - 1][0])
      expect(r.checkpoints[i][1]).toBeGreaterThan(r.checkpoints[i - 1][1])
    }
  })

  it('records nothing beyond the origin when disabled', () => {
    const r = new CheckpointRecorder(false)
    for (let i = 1; i <= 100_000; i++) r.record(i, i * 10)
    expect(r.checkpoints).toEqual([[1, 0]])
  })
})
