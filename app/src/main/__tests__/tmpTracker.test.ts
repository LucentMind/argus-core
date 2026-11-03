import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTmpTracker } from './helpers/tmpTracker'

// The tracker is installed on a *fake* fs object (DI), never on the real module:
// the real module already carries the suite-wide tracker from vitest.setup.ts,
// and wrapping it twice here would leave this test's wrapper behind for the
// rest of the worker.
function fakeFs(overrides: Partial<typeof fs> = {}): typeof fs {
  return {
    mkdtempSync: fs.mkdtempSync,
    mkdtemp: fs.mkdtemp,
    rmSync: fs.rmSync,
    promises: { mkdtemp: fs.promises.mkdtemp },
    ...overrides
  } as unknown as typeof fs
}

let root: string
let outside: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-tmptracker-root-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-tmptracker-outside-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('createTmpTracker', () => {
  it('records mkdtempSync dirs under the tmp root and removes them on cleanup', () => {
    const f = fakeFs()
    const tracker = createTmpTracker(f, root)
    tracker.install()

    const a = f.mkdtempSync(path.join(root, 'argus-home-'))
    const b = f.mkdtempSync(path.join(root, 'argus-packs-'))
    fs.writeFileSync(path.join(a, 'nested.txt'), 'x')

    expect(fs.existsSync(a)).toBe(true)
    expect(fs.existsSync(b)).toBe(true)
    expect([...tracker.paths]).toEqual([a, b])

    tracker.cleanup()

    expect(fs.existsSync(a)).toBe(false)
    expect(fs.existsSync(b)).toBe(false)
    expect(tracker.paths.size).toBe(0)
  })

  it('leaves dirs created outside the tmp root alone', () => {
    const f = fakeFs()
    const tracker = createTmpTracker(f, root)
    tracker.install()

    const elsewhere = f.mkdtempSync(path.join(outside, 'argus-home-'))

    expect(tracker.paths.size).toBe(0)
    tracker.cleanup()
    expect(fs.existsSync(elsewhere)).toBe(true)
  })

  it('records the promise and callback mkdtemp forms too', async () => {
    const f = fakeFs()
    const tracker = createTmpTracker(f, root)
    tracker.install()

    const viaPromise = await f.promises.mkdtemp(path.join(root, 'argus-p-'))
    const viaCallback = await new Promise<string>((resolve, reject) =>
      f.mkdtemp(path.join(root, 'argus-cb-'), (err, dir) => (err ? reject(err) : resolve(dir)))
    )

    expect([...tracker.paths].sort()).toEqual([viaPromise, viaCallback].sort())
    tracker.cleanup()
    expect(fs.existsSync(viaPromise)).toBe(false)
    expect(fs.existsSync(viaCallback)).toBe(false)
  })

  it('tolerates a dir the test already removed itself', () => {
    const f = fakeFs()
    const tracker = createTmpTracker(f, root)
    tracker.install()

    const a = f.mkdtempSync(path.join(root, 'argus-home-'))
    fs.rmSync(a, { recursive: true, force: true })

    expect(() => tracker.cleanup()).not.toThrow()
    expect(tracker.paths.size).toBe(0)
  })

  it('keeps going when one removal fails, so a stuck handle never fails the file', () => {
    const real = fs.rmSync
    const f = fakeFs({
      rmSync: ((p: fs.PathLike, opts?: fs.RmOptions) => {
        if (String(p).includes('argus-stuck-'))
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        return real(p, opts)
      }) as typeof fs.rmSync
    })
    const tracker = createTmpTracker(f, root)
    tracker.install()

    const stuck = f.mkdtempSync(path.join(root, 'argus-stuck-'))
    const fine = f.mkdtempSync(path.join(root, 'argus-fine-'))

    expect(() => tracker.cleanup()).not.toThrow()
    expect(fs.existsSync(stuck)).toBe(true)
    expect(fs.existsSync(fine)).toBe(false)
    expect(tracker.paths.size).toBe(0)
  })

  it('uninstall restores the original functions', () => {
    const f = fakeFs()
    const original = f.mkdtempSync
    const tracker = createTmpTracker(f, root)
    tracker.install()
    expect(f.mkdtempSync).not.toBe(original)
    tracker.uninstall()
    expect(f.mkdtempSync).toBe(original)
  })
})
