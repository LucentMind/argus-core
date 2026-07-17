import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ensureIndex,
  sidecarPath,
  checkpointAtOrBelow,
  CHECKPOINT_LINES,
  CHECKPOINT_BYTES,
  __clearIndexCacheForTests
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
})

describe('checkpointAtOrBelow', () => {
  it('binary-searches the greatest checkpoint ≤ line', () => {
    const idx = {
      mtimeMs: 0, size: 0, totalLines: 5000,
      checkpoints: [[1, 0], [1001, 11000], [2001, 22000]] as Array<[number, number]>
    }
    expect(checkpointAtOrBelow(idx, 1)).toEqual([1, 0])
    expect(checkpointAtOrBelow(idx, 1000)).toEqual([1, 0])
    expect(checkpointAtOrBelow(idx, 1001)).toEqual([1001, 11000])
    expect(checkpointAtOrBelow(idx, 4999)).toEqual([2001, 22000])
  })
})
