import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProposalsWatch } from '../proposalsWatch'
import { proposalsDir } from '../paths'
import { FS_WATCH_TIMEOUT, armFsWatch } from './fsWatchBudget'

let tmp: string, argusHome: string, onChanged: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  // realpathSync: os.tmpdir() is a /var/folders symlink into /private/var on macOS, and a
  // watcher armed on the unresolved path has to match events reported against the resolved
  // one. Same trap commit 2cfa2e86 fixed for the bundle tests' extract targets.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-proposals-watch-')))
  argusHome = path.join(tmp, 'home')
  onChanged = vi.fn<() => void>()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * Wait until the watcher is provably live, then reset the spy.
 *
 * Every test below used to write once, immediately after `createProposalsWatch`, and wait. On
 * macOS `fs.watch` returns before its FSEvents stream is armed, so that first write could be
 * lost outright — which is why raising the timeout three times never fixed this suite (see
 * `fsWatchBudget.ts`). Arming first makes each test's real assertion a single, honest write.
 *
 * The probe file is deliberately left in place: removing it would emit a further event and
 * race the `mockClear()` this returns after.
 */
async function armWatch(): Promise<void> {
  const probe = path.join(proposalsDir(argusHome), '__arm.md')
  let n = 0
  await armFsWatch(
    () => fs.writeFileSync(probe, `arm ${++n}`),
    () => onChanged.mock.calls.length > 0
  )
  onChanged.mockClear()
}

describe('proposalsWatch', () => {
  it('fires onChanged when a proposal file is written', async () => {
    const watcher = createProposalsWatch(argusHome, onChanged)
    try {
      await armWatch()
      fs.writeFileSync(path.join(proposalsDir(argusHome), 'foo.md'), '---\n---\nhi')
      await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: FS_WATCH_TIMEOUT })
    } finally {
      watcher.close()
    }
  })

  it('fires onChanged when a proposal file is deleted', async () => {
    const watcher = createProposalsWatch(argusHome, onChanged)
    try {
      await armWatch()
      const file = path.join(proposalsDir(argusHome), 'foo.md')
      fs.writeFileSync(file, '---\n---\nhi')
      await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: FS_WATCH_TIMEOUT })
      onChanged.mockClear()
      fs.rmSync(file)
      await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: FS_WATCH_TIMEOUT })
    } finally {
      watcher.close()
    }
  })

  it('debounces a burst of writes inside the debounce window', async () => {
    const watcher = createProposalsWatch(argusHome, onChanged)
    try {
      await armWatch()
      const dir = proposalsDir(argusHome)
      fs.writeFileSync(path.join(dir, 'a.md'), '1')
      fs.writeFileSync(path.join(dir, 'b.md'), '2')
      fs.writeFileSync(path.join(dir, 'c.md'), '3')
      await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: FS_WATCH_TIMEOUT })
      // let the debounce window fully settle before asserting the burst collapsed
      await new Promise((r) => setTimeout(r, 800))
      // Windows fs.watch can emit multiple raw events per write, so this is not
      // asserting exactly 1 — just that the debounce meaningfully collapsed the burst.
      expect(onChanged.mock.calls.length).toBeLessThan(3)
    } finally {
      watcher.close()
    }
  })

  it('stops firing after close()', async () => {
    const watcher = createProposalsWatch(argusHome, onChanged)
    await armWatch()
    fs.writeFileSync(path.join(proposalsDir(argusHome), 'foo.md'), 'hi')
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: FS_WATCH_TIMEOUT })
    watcher.close()
    onChanged.mockClear()
    fs.writeFileSync(path.join(proposalsDir(argusHome), 'bar.md'), 'hi')
    await new Promise((r) => setTimeout(r, 800))
    expect(onChanged).not.toHaveBeenCalled()
  })
})
