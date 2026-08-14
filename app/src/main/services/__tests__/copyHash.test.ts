import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyAndHash, hashFile } from '../copyHash'

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

  it("gives the destination the source's mode, as copyFileSync did", async () => {
    const src = path.join(tmp, 'mode.bin')
    const dest = path.join(tmp, 'mode-out.bin')
    fs.writeFileSync(src, 'x')
    // 0o600 is the one change Windows also honours (it clears the read-only bit's
    // complement), so this assertion is meaningful on every platform.
    fs.chmodSync(src, 0o600)

    await copyAndHash(src, dest)

    expect(fs.statSync(dest).mode).toBe(fs.statSync(src).mode)
  })

  it('leaves no truncated destination behind when the copy fails part-way', async () => {
    const src = path.join(tmp, 'doomed.bin')
    const dest = path.join(tmp, 'doomed-out.bin')
    fs.writeFileSync(src, crypto.randomBytes(64 * 1024))

    // Fail the first write to the destination: the file has been created by then, so
    // without cleanup a truncated orphan survives with no evidence row pointing at it.
    const realOpen = fs.promises.open
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (p, ...rest) => {
      const h = await realOpen(p as string, ...(rest as [string, number?]))
      if (p === dest) {
        h.write = async () => {
          throw new Error('disk full')
        }
      }
      return h
    })
    try {
      await expect(copyAndHash(src, dest)).rejects.toThrow(/disk full/)
    } finally {
      spy.mockRestore()
    }

    expect(fs.existsSync(dest)).toBe(false)
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

describe('hashFile', () => {
  it('returns the same digest as a whole-buffer hash', async () => {
    const src = path.join(tmp, 'h.bin')
    const bytes = crypto.randomBytes(3 * 1024 * 1024 + 17)
    fs.writeFileSync(src, bytes)
    expect(await hashFile(src)).toBe(crypto.createHash('sha256').update(bytes).digest('hex'))
  })

  it('handles an empty file', async () => {
    const src = path.join(tmp, 'h-empty.bin')
    fs.writeFileSync(src, '')
    expect(await hashFile(src)).toBe(
      crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex')
    )
  })

  // The whole point: ingestDerived runs ON the ingest queue, over the extractor's
  // output, which for a multi-GB trace is exactly the freeze this branch removed one
  // step earlier. A synchronous hash there reintroduces it.
  it('yields to the event loop while hashing', async () => {
    const src = path.join(tmp, 'h-big.bin')
    fs.writeFileSync(src, crypto.randomBytes(8 * 1024 * 1024))

    let tickRan = false
    const hashing = hashFile(src)
    setTimeout(() => {
      tickRan = true
    }, 0)
    await hashing
    expect(tickRan).toBe(true)
  })
})
