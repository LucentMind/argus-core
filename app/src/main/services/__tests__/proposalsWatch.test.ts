import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProposalsWatch } from '../proposalsWatch'
import { proposalsDir } from '../paths'

let tmp: string, argusHome: string, onChanged: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-proposals-watch-'))
  argusHome = path.join(tmp, 'home')
  onChanged = vi.fn<() => void>()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('proposalsWatch', () => {
  it('fires onChanged when a proposal file is written', async () => {
    const watcher = createProposalsWatch(argusHome, onChanged)
    try {
      fs.writeFileSync(path.join(proposalsDir(argusHome), 'foo.md'), '---\n---\nhi')
      await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 15000 })
    } finally {
      watcher.close()
    }
  })

  it('fires onChanged when a proposal file is deleted', async () => {
    const watcher = createProposalsWatch(argusHome, onChanged)
    try {
      const file = path.join(proposalsDir(argusHome), 'foo.md')
      fs.writeFileSync(file, '---\n---\nhi')
      await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 15000 })
      onChanged.mockClear()
      fs.rmSync(file)
      await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 15000 })
    } finally {
      watcher.close()
    }
  })

  it('debounces a burst of writes inside the debounce window', async () => {
    const watcher = createProposalsWatch(argusHome, onChanged)
    try {
      const dir = proposalsDir(argusHome)
      fs.writeFileSync(path.join(dir, 'a.md'), '1')
      fs.writeFileSync(path.join(dir, 'b.md'), '2')
      fs.writeFileSync(path.join(dir, 'c.md'), '3')
      await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 15000 })
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
    fs.writeFileSync(path.join(proposalsDir(argusHome), 'foo.md'), 'hi')
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 15000 })
    watcher.close()
    onChanged.mockClear()
    fs.writeFileSync(path.join(proposalsDir(argusHome), 'bar.md'), 'hi')
    await new Promise((r) => setTimeout(r, 800))
    expect(onChanged).not.toHaveBeenCalled()
  })
})
