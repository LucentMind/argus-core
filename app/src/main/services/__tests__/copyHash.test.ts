import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyAndHash } from '../copyHash'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-copyhash-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('copyAndHash', () => {
  it('copies the bytes and returns the same digest as a separate hash pass', async () => {
    const src = path.join(tmp, 'src.bin')
    const dest = path.join(tmp, 'dest.bin')
    const bytes = crypto.randomBytes(3 * 1024 * 1024 + 17)
    fs.writeFileSync(src, bytes)

    const { sha256, size } = await copyAndHash(src, dest)

    expect(fs.readFileSync(dest).equals(bytes)).toBe(true)
    expect(size).toBe(bytes.length)
    expect(sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'))
  })

  it('handles an empty file', async () => {
    const src = path.join(tmp, 'empty.bin')
    const dest = path.join(tmp, 'empty-out.bin')
    fs.writeFileSync(src, '')
    const { sha256, size } = await copyAndHash(src, dest)
    expect(size).toBe(0)
    expect(sha256).toBe(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
  })

  it('yields to the event loop while copying', async () => {
    const src = path.join(tmp, 'big.bin')
    const dest = path.join(tmp, 'big-out.bin')
    fs.writeFileSync(src, crypto.randomBytes(8 * 1024 * 1024))

    let tickRan = false
    const copying = copyAndHash(src, dest)
    setTimeout(() => {
      tickRan = true
    }, 0)
    await copying
    expect(tickRan).toBe(true)
  })
})
