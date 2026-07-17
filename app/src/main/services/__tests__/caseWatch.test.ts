import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCaseWatchHub, type CaseWatchHub } from '../caseWatch'
import { caseDir } from '../paths'

let tmp: string, argusHome: string, hub: CaseWatchHub, events: string[]

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-watch-'))
  argusHome = path.join(tmp, 'home')
  fs.mkdirSync(path.join(caseDir(argusHome, 'C1'), 'evidence'), { recursive: true })
  events = []
  hub = createCaseWatchHub(argusHome, (slug) => events.push(slug))
})

afterEach(() => {
  hub.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('caseWatch hub', () => {
  it('broadcasts (debounced) on a file change in the case dir', async () => {
    hub.watch('C1')
    fs.writeFileSync(path.join(caseDir(argusHome, 'C1'), 'evidence', 'x.txt'), 'hi')
    await vi.waitFor(() => expect(events).toContain('C1'), { timeout: 3000 })
  })

  it('suppress() swallows self-caused events inside the window', async () => {
    hub.watch('C1')
    hub.suppress('C1', 2000)
    fs.writeFileSync(path.join(caseDir(argusHome, 'C1'), 'evidence', 'y.txt'), 'hi')
    await new Promise((r) => setTimeout(r, 800)) // > debounce, < suppression
    expect(events).toEqual([])
  })

  it('watch() is idempotent and rejects hostile slugs', () => {
    hub.watch('C1')
    hub.watch('C1') // no throw, single watcher
    expect(() => hub.watch('..')).toThrow()
  })

  it('unwatch() stops events', async () => {
    hub.watch('C1')
    hub.unwatch('C1')
    fs.writeFileSync(path.join(caseDir(argusHome, 'C1'), 'evidence', 'z.txt'), 'hi')
    await new Promise((r) => setTimeout(r, 800))
    expect(events).toEqual([])
  })

  it('ignores writes outside evidence/ (agent session mirrors)', async () => {
    hub.watch('C1')
    const sessions = path.join(caseDir(argusHome, 'C1'), 'sessions')
    fs.mkdirSync(sessions, { recursive: true })
    fs.writeFileSync(path.join(sessions, 's.jsonl'), '{}')
    await new Promise((r) => setTimeout(r, 800))
    expect(events).toEqual([])
  })

  it('ignores writes in evidence dot-dirs (.meta/.derived are pipeline-managed)', async () => {
    hub.watch('C1')
    const metaDir = path.join(caseDir(argusHome, 'C1'), 'evidence', '.meta')
    fs.mkdirSync(metaDir, { recursive: true })
    fs.writeFileSync(path.join(metaDir, 'x.json'), '{}')
    await new Promise((r) => setTimeout(r, 800))
    expect(events).toEqual([])
  })

  it('ignores case.json writes at the case root', async () => {
    hub.watch('C1')
    fs.writeFileSync(path.join(caseDir(argusHome, 'C1'), 'case.json'), '{}')
    await new Promise((r) => setTimeout(r, 800))
    expect(events).toEqual([])
  })

  it('suppress() is monotonic — a later short window never shrinks a longer one', async () => {
    hub.watch('C1')
    hub.suppress('C1', 5000)
    hub.suppress('C1', 1) // must NOT shrink the 5000ms window
    fs.writeFileSync(path.join(caseDir(argusHome, 'C1'), 'evidence', 'm.txt'), 'hi')
    await new Promise((r) => setTimeout(r, 800)) // > debounce; inside the 5000ms window
    expect(events).toEqual([])
  })
})
