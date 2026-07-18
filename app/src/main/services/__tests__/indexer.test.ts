import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { indexEvidenceText, indexEvidenceFile, deleteEvidenceIndex } from '../indexer'
import { sidecarPath, ensureIndex, __clearIndexCacheForTests } from '../lineIndex'
import { MAX_READ_BYTES } from '../search'
import type { DatabaseSync } from 'node:sqlite'

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
        `SELECT chunk_index, start_line, end_line FROM evidence_fts WHERE evidence_id = 7 ORDER BY chunk_index`
      )
      .all() as { chunk_index: number; start_line: number; end_line: number }[]
    expect(rows).toEqual([
      { chunk_index: 0, start_line: 1, end_line: 400 },
      { chunk_index: 1, start_line: 401, end_line: 800 },
      { chunk_index: 2, start_line: 801, end_line: 950 }
    ])
  })

  it('is searchable and deletable', () => {
    const db = freshDb()
    indexEvidenceText(db, 3, 'alpha beta\ngamma TileStore error here\n', 400)
    const hit = db
      .prepare(`SELECT evidence_id FROM evidence_fts WHERE evidence_fts MATCH ?`)
      .get('"TileStore error"') as { evidence_id: number } | undefined
    expect(hit?.evidence_id).toBe(3)
    deleteEvidenceIndex(db, 3)
    const after = db
      .prepare(`SELECT count(*) AS n FROM evidence_fts WHERE evidence_id = 3`)
      .get() as { n: number }
    expect(after.n).toBe(0)
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
        `SELECT chunk_index, start_line, end_line FROM evidence_fts WHERE evidence_id = 9 ORDER BY chunk_index`
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
