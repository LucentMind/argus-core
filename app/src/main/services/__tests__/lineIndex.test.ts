import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ensureIndex,
  sidecarPath,
  checkpointAtOrBelow,
  __clearIndexCacheForTests,
  getLines,
  MAX_LINES_PER_READ,
  searchLines
} from '../lineIndex'

let tmp: string, argusHome: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-li-'))
  argusHome = path.join(tmp, 'home')
  __clearIndexCacheForTests()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function writeLines(name: string, count: number, width = 10): string {
  const p = path.join(tmp, name)
  const fd = fs.openSync(p, 'w')
  for (let i = 1; i <= count; i++) fs.writeSync(fd, `${String(i).padStart(width, '0')}\n`)
  fs.closeSync(fd)
  return p
}

describe('ensureIndex', () => {
  it('counts lines and checkpoints every CHECKPOINT_LINES', async () => {
    const p = writeLines('a.txt', 2500)
    const idx = await ensureIndex(argusHome, p)
    expect(idx.totalLines).toBe(2500)
    // [1,0] plus checkpoints at 1001 and 2001; each line is 11 bytes
    expect(idx.checkpoints).toEqual([
      [1, 0],
      [1001, 1000 * 11],
      [2001, 2000 * 11]
    ])
  })

  it('inserts byte-triggered checkpoints for near-newline-free files', async () => {
    const p = path.join(tmp, 'wide.txt')
    // 3 lines of 5MB each — line trigger never fires, byte trigger must
    const big = 'x'.repeat(5 * 1024 * 1024)
    fs.writeFileSync(p, `${big}\n${big}\n${big}\n`)
    const idx = await ensureIndex(argusHome, p)
    expect(idx.totalLines).toBe(3)
    expect(idx.checkpoints.length).toBeGreaterThan(1)
    for (const [, byte] of idx.checkpoints.slice(1)) expect(byte).toBeGreaterThan(0)
  })

  it('persists a sidecar and reuses it; rebuilds when mtime/size change', async () => {
    const p = writeLines('b.txt', 1500)
    const idx1 = await ensureIndex(argusHome, p)
    expect(fs.existsSync(sidecarPath(argusHome, p))).toBe(true)
    __clearIndexCacheForTests() // drop memory cache → forces sidecar load
    const idx2 = await ensureIndex(argusHome, p)
    expect(idx2).toEqual(idx1)
    // grow the file → stale sidecar must be rebuilt
    fs.appendFileSync(p, 'extra line\n')
    __clearIndexCacheForTests()
    const idx3 = await ensureIndex(argusHome, p)
    expect(idx3.totalLines).toBe(1501)
  })

  it('rebuilds when a sidecar has valid metadata but malformed checkpoints', async () => {
    const p = writeLines('mal.txt', 1500)
    const idx1 = await ensureIndex(argusHome, p)
    const side = sidecarPath(argusHome, p)
    for (const badCheckpoints of [
      'nope', // not an array
      [], // missing the mandatory [1, 0] seed
      [[2, 5]], // wrong seed
      [
        [1, 0],
        ['x', 3]
      ] // non-numeric entry
    ]) {
      fs.writeFileSync(
        side,
        JSON.stringify({
          version: 1,
          mtimeMs: idx1.mtimeMs,
          size: idx1.size,
          totalLines: idx1.totalLines,
          checkpoints: badCheckpoints
        })
      )
      __clearIndexCacheForTests()
      const rebuilt = await ensureIndex(argusHome, p)
      expect(rebuilt.checkpoints).toEqual(idx1.checkpoints)
      expect(rebuilt.totalLines).toBe(1500)
    }
  })

  it('handles empty file and file with no trailing newline', async () => {
    const empty = path.join(tmp, 'empty.txt')
    fs.writeFileSync(empty, '')
    expect((await ensureIndex(argusHome, empty)).totalLines).toBe(0)
    const noNl = path.join(tmp, 'nonl.txt')
    fs.writeFileSync(noNl, 'one\ntwo')
    expect((await ensureIndex(argusHome, noNl)).totalLines).toBe(2)
  })

  it('reports progress fractions ending at 1', async () => {
    const p = writeLines('c.txt', 100)
    const fractions: number[] = []
    await ensureIndex(argusHome, p, (f) => fractions.push(f))
    expect(fractions[fractions.length - 1]).toBe(1)
  })

  it('returns the same object from the memory cache on a hit', async () => {
    const p = writeLines('hit.txt', 10)
    const a = await ensureIndex(argusHome, p)
    const b = await ensureIndex(argusHome, p)
    expect(b).toBe(a)
  })

  it('promotes entries on hit so LRU evicts the least recently used', async () => {
    const pA = writeLines('lru-a.txt', 5)
    const a1 = await ensureIndex(argusHome, pA)
    // fill the cache to capacity (16) with 15 more distinct files
    const others: string[] = []
    const otherIdx: unknown[] = []
    for (let i = 0; i < 15; i++) {
      const p = writeLines(`lru-${i}.txt`, 5)
      others.push(p)
      otherIdx.push(await ensureIndex(argusHome, p))
    }
    // re-hit A → promotion moves it to most-recently-used
    const a2 = await ensureIndex(argusHome, pA)
    expect(a2).toBe(a1)
    // 17th distinct file → evicts the true LRU (others[0]), not A
    const pNew = writeLines('lru-new.txt', 5)
    await ensureIndex(argusHome, pNew)
    const a3 = await ensureIndex(argusHome, pA)
    expect(a3).toBe(a1)
    // others[0] was evicted → re-ensure yields a fresh object, not the cached one
    const rebuilt = await ensureIndex(argusHome, others[0])
    expect(rebuilt).not.toBe(otherIdx[0])
  })
})

describe('checkpointAtOrBelow', () => {
  it('binary-searches the greatest checkpoint ≤ line', () => {
    const idx = {
      mtimeMs: 0,
      size: 0,
      totalLines: 5000,
      checkpoints: [
        [1, 0],
        [1001, 11000],
        [2001, 22000]
      ] as Array<[number, number]>
    }
    expect(checkpointAtOrBelow(idx, 1)).toEqual([1, 0])
    expect(checkpointAtOrBelow(idx, 1000)).toEqual([1, 0])
    expect(checkpointAtOrBelow(idx, 1001)).toEqual([1001, 11000])
    expect(checkpointAtOrBelow(idx, 4999)).toEqual([2001, 22000])
  })
})

describe('getLines', () => {
  it('returns exactly the requested range, matching a naive full read', async () => {
    const p = writeLines('g.txt', 5000)
    const idx = await ensureIndex(argusHome, p)
    const naive = fs.readFileSync(p, 'utf8').split('\n')
    for (const [from, to] of [
      [1, 5],
      [999, 1002],
      [1001, 1001],
      [4990, 5000]
    ]) {
      const r = getLines(idx, p, from, to)
      expect(r.from).toBe(from)
      expect(r.lines).toEqual(naive.slice(from - 1, to))
    }
  })

  it('clamps: from<1, to>totalLines, from>totalLines, and MAX_LINES_PER_READ', async () => {
    const p = writeLines('h.txt', 3000)
    const idx = await ensureIndex(argusHome, p)
    expect(getLines(idx, p, -5, 2).from).toBe(1)
    expect(getLines(idx, p, 2999, 99999).lines).toHaveLength(2)
    expect(getLines(idx, p, 5000, 5100).lines).toEqual([])
    expect(getLines(idx, p, 1, 3000).lines).toHaveLength(MAX_LINES_PER_READ)
  })

  it('returns empty for a reversed range', async () => {
    const p = writeLines('h.txt', 3000)
    const idx = await ensureIndex(argusHome, p)
    expect(getLines(idx, p, 10, 5).lines).toEqual([])
  })

  it('reads the final unterminated line', async () => {
    const p = path.join(tmp, 'tail.txt')
    fs.writeFileSync(p, 'a\nb\nlast-no-newline')
    const idx = await ensureIndex(argusHome, p)
    expect(getLines(idx, p, 3, 3).lines).toEqual(['last-no-newline'])
  })
})

async function drain(
  gen: AsyncGenerator<{ hits: number[]; scannedTo: number; done: boolean; capped: boolean }>
): Promise<{ hits: number[]; scannedTo: number; done: boolean; capped: boolean }> {
  const hits: number[] = []
  let last = { scannedTo: 0, done: false, capped: false }
  for await (const b of gen) {
    hits.push(...b.hits)
    last = b
  }
  return { hits, ...last }
}

describe('searchLines', () => {
  it('finds substring matches with correct line numbers (case-insensitive default)', async () => {
    const p = path.join(tmp, 's.txt')
    fs.writeFileSync(p, 'alpha\nBETA\ngamma\nbeta tail\n')
    const idx = await ensureIndex(argusHome, p)
    const r = await drain(searchLines(idx, p, 'beta'))
    expect(r.hits).toEqual([2, 4])
    expect(r.done).toBe(true)
    expect(r.capped).toBe(false)
    expect((await drain(searchLines(idx, p, 'BETA', { caseSensitive: true }))).hits).toEqual([2])
  })

  it('supports regex mode', async () => {
    const p = path.join(tmp, 'r.txt')
    fs.writeFileSync(p, 'err 1\nwarn\nerr 22\n')
    const idx = await ensureIndex(argusHome, p)
    expect((await drain(searchLines(idx, p, 'err \\d+', { regex: true }))).hits).toEqual([1, 3])
  })

  it('scopes to [fromLine, toLine] — second-half search works', async () => {
    const p = writeLines('half.txt', 4000) // every line matches '0'
    const idx = await ensureIndex(argusHome, p)
    const r = await drain(searchLines(idx, p, '0', { fromLine: 2001 }))
    expect(r.hits[0]).toBe(2001)
    expect(r.hits).toHaveLength(2000)
    const r2 = await drain(searchLines(idx, p, '0', { fromLine: 100, toLine: 110 }))
    expect(r2.hits).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110])
  })

  it('caps at maxResults with a resume cursor', async () => {
    const p = writeLines('cap.txt', 500)
    const idx = await ensureIndex(argusHome, p)
    const r = await drain(searchLines(idx, p, '0', { maxResults: 100 }))
    expect(r.hits).toHaveLength(100)
    expect(r.capped).toBe(true)
    expect(r.scannedTo).toBe(100)
    const resumed = await drain(
      searchLines(idx, p, '0', { fromLine: r.scannedTo + 1, maxResults: 100 })
    )
    expect(resumed.hits[0]).toBe(101)
  })

  it('aborts via signal', async () => {
    const p = writeLines('ab.txt', 2000)
    const idx = await ensureIndex(argusHome, p)
    const ac = new AbortController()
    ac.abort()
    const r = await drain(searchLines(idx, p, '0', { signal: ac.signal }))
    expect(r.hits).toEqual([])
    expect(r.done).toBe(false)
  })

  it('streams multiple batches with no loss or duplication', async () => {
    // 500k lines: with SEARCH_BATCH_LINES = 100_000 each streamed batch needs
    // ≥100k scanned lines, so ≥3 streamed batches require >300k lines.
    const p = writeLines('stream.txt', 500_000)
    const idx = await ensureIndex(argusHome, p)
    const batches: Array<{ hits: number[]; scannedTo: number; done: boolean; capped: boolean }> = []
    for await (const b of searchLines(idx, p, '0', { maxResults: 600_000 })) batches.push(b)
    expect(batches.length).toBeGreaterThanOrEqual(4) // ≥3 streamed batches before the final one
    const final = batches[batches.length - 1]
    expect(final.done).toBe(true)
    expect(final.capped).toBe(false)
    const all = batches.flatMap((b) => b.hits)
    expect(all).toHaveLength(500_000)
    expect(all[0]).toBe(1)
    expect(all[all.length - 1]).toBe(500_000)
    expect(all.every((v, i) => v === i + 1)).toBe(true) // no loss, no dup
  })

  it('aborts mid-stream after partial batches were delivered', async () => {
    const p = writeLines('abmid.txt', 250_000)
    const idx = await ensureIndex(argusHome, p)
    const ac = new AbortController()
    const received: Array<{ hits: number[]; done: boolean }> = []
    for await (const b of searchLines(idx, p, '0', { maxResults: 300_000, signal: ac.signal })) {
      received.push(b)
      if (received.length === 1) {
        expect(b.hits.length).toBeGreaterThan(0) // hits already collected pre-abort
        ac.abort()
      }
    }
    expect(received[received.length - 1].done).toBe(false)
    const total = received.reduce((n, b) => n + b.hits.length, 0)
    expect(total).toBeLessThan(250_000)
  })

  it('matches anchored regexes on CRLF files (matcher strips \\r)', async () => {
    const p = path.join(tmp, 'crlf.txt')
    fs.writeFileSync(p, 'alpha\r\nbeta\r\n')
    const idx = await ensureIndex(argusHome, p)
    expect((await drain(searchLines(idx, p, 'alpha$', { regex: true }))).hits).toEqual([1])
  })

  it('throws on invalid regex at first .next()', async () => {
    const p = writeLines('bad.txt', 5)
    const idx = await ensureIndex(argusHome, p)
    await expect(drain(searchLines(idx, p, '[', { regex: true }))).rejects.toThrow()
  })

  it('filter option: a line must match filter AND query', async () => {
    const p = path.join(tmp, 'fq.txt')
    fs.writeFileSync(p, 'CTX1 info a\nCTX2 info b\nCTX1 warn c\nCTX1 info d\n')
    const idx = await ensureIndex(argusHome, p)
    const r = await drain(searchLines(idx, p, 'info', { filter: { query: 'CTX1' } }))
    expect(r.hits).toEqual([1, 4])
    const rx = await drain(
      searchLines(idx, p, 'info [ad]$', { regex: true, filter: { query: 'CTX\\d', regex: true } })
    )
    expect(rx.hits).toEqual([1, 4])
  })

  it('filter option: respects range scoping and throws on invalid filter regex', async () => {
    const p = path.join(tmp, 'fr.txt')
    fs.writeFileSync(
      p,
      Array.from({ length: 100 }, (_, i) => `CTX1 line ${i + 1}`).join('\n') + '\n'
    )
    const idx = await ensureIndex(argusHome, p)
    const r = await drain(
      searchLines(idx, p, 'line', { fromLine: 50, toLine: 60, filter: { query: 'CTX1' } })
    )
    expect(r.hits).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60])
    await expect(
      drain(searchLines(idx, p, 'line', { filter: { query: '[', regex: true } }))
    ).rejects.toThrow()
  })
})
