import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DraftStore, draftKey } from '../drafts'
import type { DraftChange, DraftRecord } from '../../../shared/editorIpc'

let home: string
const NOW = new Date('2026-07-30T15:42:00.000Z')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-drafts-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function store(): DraftStore {
  return new DraftStore({ argusHome: home, now: () => NOW })
}

const CHANGE: DraftChange = {
  kind: 'skill',
  name: 'my-skill',
  mode: 'edit',
  content: '# typing\n',
  baseHash: 'disk-hash'
}

const file = (kind: 'skill' | 'reference', name: string): string =>
  path.join(home, 'drafts', `${draftKey(kind, name)}.json`)

describe('draftKey', () => {
  it('is a 16-char hex key', () => {
    expect(draftKey('skill', 'my-skill')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('separates the kinds, so a skill and a reference of the same name never collide', () => {
    expect(draftKey('skill', 'notes')).not.toBe(draftKey('reference', 'notes'))
  })

  it('survives a name that would be an illegal filename', () => {
    expect(draftKey('reference', 'a/b .md')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('DraftStore write and read', () => {
  it('has no draft before anything is queued', () => {
    expect(store().read('skill', 'my-skill')).toBeNull()
  })

  it('writes a queued change to drafts/<key>.json on flush', () => {
    const s = store()
    s.queue(CHANGE)
    s.flushAll()
    const raw = JSON.parse(fs.readFileSync(file('skill', 'my-skill'), 'utf8')) as DraftRecord
    expect(raw).toEqual({ ...CHANGE, updatedAt: NOW.toISOString() })
  })

  it('reads a draft back through a fresh store', () => {
    const s = store()
    s.queue(CHANGE)
    s.flushAll()
    expect(store().read('skill', 'my-skill')?.content).toBe('# typing\n')
  })

  it('reads the queued copy before it reaches disk', () => {
    // A tab reopened moments after it was closed must not be handed the previous, older write.
    const s = store()
    s.queue(CHANGE)
    s.queue({ ...CHANGE, content: 'newer' })
    expect(s.read('skill', 'my-skill')?.content).toBe('newer')
  })

  it('keeps `replaces` out of the persisted record', () => {
    const s = store()
    s.queue({ ...CHANGE, replaces: { kind: 'skill', name: 'old-name' } })
    s.flushAll()
    const raw = JSON.parse(fs.readFileSync(file('skill', 'my-skill'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(raw.replaces).toBeUndefined()
  })

  it('records a create-mode draft with a null baseHash', () => {
    const s = store()
    s.queue({ kind: 'skill', name: 'brand-new', mode: 'create', content: 'x', baseHash: null })
    s.flushAll()
    expect(store().read('skill', 'brand-new')?.baseHash).toBeNull()
  })

  it('returns null rather than throwing on a corrupt draft file', () => {
    fs.mkdirSync(path.join(home, 'drafts'), { recursive: true })
    fs.writeFileSync(file('skill', 'my-skill'), '{not json', 'utf8')
    expect(store().read('skill', 'my-skill')).toBeNull()
  })

  it('returns null rather than throwing on a draft file missing its content', () => {
    fs.mkdirSync(path.join(home, 'drafts'), { recursive: true })
    fs.writeFileSync(file('skill', 'my-skill'), JSON.stringify({ kind: 'skill' }), 'utf8')
    expect(store().read('skill', 'my-skill')).toBeNull()
  })
})

describe('DraftStore.discard', () => {
  it('removes the file', () => {
    const s = store()
    s.queue(CHANGE)
    s.flushAll()
    s.discard('skill', 'my-skill')
    expect(fs.existsSync(file('skill', 'my-skill'))).toBe(false)
    expect(s.read('skill', 'my-skill')).toBeNull()
  })

  it('drops a change queued but not yet written', () => {
    const s = store()
    s.queue(CHANGE)
    s.discard('skill', 'my-skill')
    s.flushAll()
    expect(fs.existsSync(file('skill', 'my-skill'))).toBe(false)
  })

  it('is a no-op when there is no draft', () => {
    expect(() => store().discard('skill', 'nothing')).not.toThrow()
  })

  // Finding 4: writeKey writes `<key>.json.tmp` before renaming it onto `<key>.json`. If the
  // rename throws, the temp file is left behind, and nothing but discard ever sweeps it.
  it('removes a <key>.json.tmp left behind by a failed rename', () => {
    const s = store()
    const tmp = `${file('skill', 'my-skill')}.tmp`
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EPERM: rename failed')
    })
    s.queue(CHANGE)
    s.flushAll()
    renameSpy.mockRestore()
    // Sanity: the write really did leave the temp file behind, not that discard cleans up
    // something that was never there.
    expect(fs.existsSync(tmp)).toBe(true)

    s.discard('skill', 'my-skill')
    expect(fs.existsSync(tmp)).toBe(false)
    expect(fs.existsSync(file('skill', 'my-skill'))).toBe(false)
  })

  it('discarding a draft with no stray .tmp file is still a no-op', () => {
    const s = store()
    s.queue(CHANGE)
    s.flushAll()
    expect(() => s.discard('skill', 'my-skill')).not.toThrow()
  })

  // Hardening (final-review-fixes-2): the same Finding-4 leak, one key over. A rename whose
  // write fails at the rename step leaves `<oldKey>.json.tmp` behind under the *ancestor's* key,
  // not the live one — discard's ancestor loop is the only place that key's lifetime is ever
  // known to end, so it has to sweep the temp file too, not just `<oldKey>.json`.
  it("sweeps a stranded ancestor's .tmp file when the live key is discarded before its own write", () => {
    const s = store()
    const tmpA = `${file('skill', 'a')}.tmp`
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EPERM: rename failed')
    })
    s.queue({ ...CHANGE, name: 'a' })
    s.flushAll()
    renameSpy.mockRestore()
    // Sanity: 'a' really did leave a temp file behind rather than a fully-written one.
    expect(fs.existsSync(tmpA)).toBe(true)
    expect(fs.existsSync(file('skill', 'a'))).toBe(false)

    s.queue({ ...CHANGE, name: 'b', replaces: { kind: 'skill', name: 'a' } })
    s.discard('skill', 'b')
    expect(fs.existsSync(tmpA)).toBe(false)
  })
})

describe('DraftStore rename chains', () => {
  it('deletes every stranded key when a rename moves twice inside one debounce window', () => {
    const s = store()
    s.queue({ ...CHANGE, name: 'a' })
    s.flushAll()
    s.queue({ ...CHANGE, name: 'b', replaces: { kind: 'skill', name: 'a' } })
    s.queue({ ...CHANGE, name: 'c', replaces: { kind: 'skill', name: 'b' } })
    s.flushAll()

    expect(fs.existsSync(file('skill', 'a'))).toBe(false)
    expect(fs.existsSync(file('skill', 'b'))).toBe(false)
    expect(store().read('skill', 'c')?.content).toBe('# typing\n')
  })

  it('keeps the draft when a rename chain returns to a name it already used', () => {
    const s = store()
    s.queue({ ...CHANGE, name: 'a' })
    s.flushAll()
    s.queue({ ...CHANGE, name: 'b', replaces: { kind: 'skill', name: 'a' } })
    s.queue({ ...CHANGE, name: 'a', replaces: { kind: 'skill', name: 'b' } })
    s.flushAll()

    expect(store().read('skill', 'a')?.content).toBe('# typing\n')
    expect(fs.existsSync(file('skill', 'b'))).toBe(false)
  })

  it('discard removes the names the draft was renamed away from', () => {
    const s = store()
    s.queue({ ...CHANGE, name: 'a' })
    s.flushAll()
    s.queue({ ...CHANGE, name: 'b', replaces: { kind: 'skill', name: 'a' } })
    s.discard('skill', 'b')
    s.flushAll()

    expect(fs.existsSync(file('skill', 'a'))).toBe(false)
    expect(fs.existsSync(file('skill', 'b'))).toBe(false)
  })

  // Hardening (final-review-fixes-2): mirrors the discard-side test above, but for the ancestor
  // loop that runs after a *successful* write — `writeKey`'s own stranded-ancestor cleanup, not
  // `discard`'s.
  it("sweeps a stranded ancestor's .tmp file once the renamed-to key finishes writing", () => {
    const s = store()
    const tmpA = `${file('skill', 'a')}.tmp`
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EPERM: rename failed')
    })
    s.queue({ ...CHANGE, name: 'a' })
    s.flushAll()
    renameSpy.mockRestore()
    expect(fs.existsSync(tmpA)).toBe(true)
    expect(fs.existsSync(file('skill', 'a'))).toBe(false)

    s.queue({ ...CHANGE, name: 'b', replaces: { kind: 'skill', name: 'a' } })
    s.flushAll()

    expect(fs.existsSync(tmpA)).toBe(false)
    expect(store().read('skill', 'b')?.content).toBe('# typing\n')
  })
})

describe('DraftStore.onSaved', () => {
  it('fires once per write, with the persisted record', () => {
    const seen: DraftRecord[] = []
    const s = store()
    s.onSaved((r) => seen.push(r))
    s.queue(CHANGE)
    s.flushAll()
    expect(seen).toEqual([{ ...CHANGE, updatedAt: NOW.toISOString() }])
  })

  it('does not fire when nothing is queued', () => {
    const seen: DraftRecord[] = []
    const s = store()
    s.onSaved((r) => seen.push(r))
    s.flushAll()
    expect(seen).toEqual([])
  })
})

describe('DraftStore debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes after the idle window, not on the keystroke', () => {
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    s.queue(CHANGE)
    expect(fs.existsSync(file('skill', 'my-skill'))).toBe(false)
    vi.advanceTimersByTime(500)
    expect(fs.existsSync(file('skill', 'my-skill'))).toBe(true)
  })

  it('coalesces a burst of keystrokes into one write', () => {
    const seen: DraftRecord[] = []
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    s.onSaved((r) => seen.push(r))
    s.queue({ ...CHANGE, content: 'a' })
    vi.advanceTimersByTime(200)
    s.queue({ ...CHANGE, content: 'ab' })
    vi.advanceTimersByTime(200)
    s.queue({ ...CHANGE, content: 'abc' })
    vi.advanceTimersByTime(500)
    expect(seen.map((r) => r.content)).toEqual(['abc'])
  })

  it('debounces each asset independently', () => {
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    s.queue(CHANGE)
    s.queue({ kind: 'reference', name: 'notes.md', mode: 'edit', content: 'r', baseHash: 'h' })
    vi.advanceTimersByTime(500)
    expect(store().read('skill', 'my-skill')?.content).toBe('# typing\n')
    expect(store().read('reference', 'notes.md')?.content).toBe('r')
  })

  it('flushAll writes the pending change immediately and cancels its timer', () => {
    const seen: DraftRecord[] = []
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    s.onSaved((r) => seen.push(r))
    s.queue(CHANGE)
    s.flushAll()
    expect(store().read('skill', 'my-skill')?.content).toBe('# typing\n')
    // The cancelled timer must not fire a second write after the flush.
    vi.advanceTimersByTime(2000)
    expect(seen).toHaveLength(1)
  })

  it('flushAll on an empty store is a no-op', () => {
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    expect(() => s.flushAll()).not.toThrow()
  })
})

describe('DraftStore re-key on rename (spec §4.5)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('moves the draft to the new name and removes the old file', () => {
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    s.queue({ ...CHANGE, name: 'old-name' })
    vi.advanceTimersByTime(500)
    expect(fs.existsSync(file('skill', 'old-name'))).toBe(true)

    s.queue({ ...CHANGE, name: 'new-name', replaces: { kind: 'skill', name: 'old-name' } })
    vi.advanceTimersByTime(500)

    expect(fs.existsSync(file('skill', 'old-name'))).toBe(false)
    expect(store().read('skill', 'new-name')?.content).toBe('# typing\n')
  })

  it('drops the old name from the queue so it is never written after the rename', () => {
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    s.queue({ ...CHANGE, name: 'old-name' })
    // Renamed before the old key's timer ever fired.
    s.queue({ ...CHANGE, name: 'new-name', replaces: { kind: 'skill', name: 'old-name' } })
    vi.advanceTimersByTime(500)
    expect(fs.existsSync(file('skill', 'old-name'))).toBe(false)
    expect(fs.existsSync(file('skill', 'new-name'))).toBe(true)
  })

  it('ignores a `replaces` that names the same asset', () => {
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    s.queue({ ...CHANGE, replaces: { kind: 'skill', name: 'my-skill' } })
    vi.advanceTimersByTime(500)
    expect(store().read('skill', 'my-skill')?.content).toBe('# typing\n')
  })
})

describe('DraftStore.list', () => {
  it('returns [] when the drafts dir does not exist yet', () => {
    expect(store().list()).toEqual([])
  })

  it('returns every draft written to disk', () => {
    const s = store()
    s.queue({ ...CHANGE, name: 'a' })
    s.queue({ ...CHANGE, name: 'b' })
    s.flushAll()
    const names = store()
      .list()
      .map((r) => r.name)
      .sort()
    expect(names).toEqual(['a', 'b'])
  })

  it('prefers a pending change over its disk copy', () => {
    const s = store()
    s.queue(CHANGE)
    s.flushAll()
    s.queue({ ...CHANGE, content: 'still typing' })
    const rec = s.list().find((r) => r.name === 'my-skill')
    expect(rec?.content).toBe('still typing')
  })

  it('skips a corrupt draft file rather than throwing', () => {
    fs.mkdirSync(path.join(home, 'drafts'), { recursive: true })
    fs.writeFileSync(file('skill', 'my-skill'), '{not json', 'utf8')
    expect(store().list()).toEqual([])
  })
})

describe('DraftStore write failure', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the change queued when the write throws, and lands it on the retry', () => {
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    // A file where the drafts directory should be: mkdirSync throws ENOTDIR/EEXIST.
    fs.writeFileSync(path.join(home, 'drafts'), 'not a directory', 'utf8')

    s.queue(CHANGE)
    vi.advanceTimersByTime(500)
    // Persist-before-adopt: nothing on disk, so the queued copy must still be there.
    expect(s.read('skill', 'my-skill')?.content).toBe('# typing\n')

    fs.rmSync(path.join(home, 'drafts'))
    s.flushAll()
    expect(store().read('skill', 'my-skill')?.content).toBe('# typing\n')
  })

  it('does not announce a save that did not happen', () => {
    const seen: DraftRecord[] = []
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    s.onSaved((r) => seen.push(r))
    fs.writeFileSync(path.join(home, 'drafts'), 'not a directory', 'utf8')
    s.queue(CHANGE)
    vi.advanceTimersByTime(500)
    expect(seen).toEqual([])
  })

  // Finding 5: a persistent write failure used to be signalled only by the absence of a
  // "Draft ·" chip — unactionable for a user, untriageable for a developer. It must at least
  // reach the console, naming the draft key, without disturbing the requeue-and-retry behavior
  // the other tests in this describe block pin down.
  it('logs the failure, naming the draft key', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    fs.writeFileSync(path.join(home, 'drafts'), 'not a directory', 'utf8')
    s.queue(CHANGE)
    vi.advanceTimersByTime(500)

    expect(errSpy).toHaveBeenCalledTimes(1)
    const [message] = errSpy.mock.calls[0] as [string]
    expect(message).toContain(draftKey('skill', 'my-skill'))
    errSpy.mockRestore()
  })
})
