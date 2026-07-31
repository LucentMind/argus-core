import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DraftStore, draftKey, keyOf } from '../drafts'
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

const idFile = (draftId: string): string => path.join(home, 'drafts', `${keyOf({ draftId })}.json`)

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

describe('keyOf', () => {
  it('keys an edit-mode ref (kind+name) the same as draftKey', () => {
    expect(keyOf({ kind: 'skill', name: 'my-skill' })).toBe(draftKey('skill', 'my-skill'))
  })

  it('gives two create drafts that share a name different keys, since it never reads name', () => {
    // The whole point of the id-based scheme: two create tabs both typed "shared" should not
    // land on the same storage key just because the field currently holds the same text.
    expect(keyOf({ draftId: 'draft-a' })).not.toBe(keyOf({ draftId: 'draft-b' }))
  })

  it('gives the same key for the same draftId every time', () => {
    expect(keyOf({ draftId: 'draft-a' })).toBe(keyOf({ draftId: 'draft-a' }))
  })

  it('is a 16-char hex key for a draftId ref too', () => {
    expect(keyOf({ draftId: 'draft-a' })).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('DraftStore write and read', () => {
  it('has no draft before anything is queued', () => {
    expect(store().read({ kind: 'skill', name: 'my-skill' })).toBeNull()
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
    expect(store().read({ kind: 'skill', name: 'my-skill' })?.content).toBe('# typing\n')
  })

  it('reads the queued copy before it reaches disk', () => {
    // A tab reopened moments after it was closed must not be handed the previous, older write.
    const s = store()
    s.queue(CHANGE)
    s.queue({ ...CHANGE, content: 'newer' })
    expect(s.read({ kind: 'skill', name: 'my-skill' })?.content).toBe('newer')
  })

  it('records a create-mode draft under its draftId, with a null baseHash', () => {
    const s = store()
    s.queue({
      kind: 'skill',
      name: 'brand-new',
      mode: 'create',
      content: 'x',
      baseHash: null,
      draftId: 'draft-1'
    })
    s.flushAll()
    expect(store().read({ draftId: 'draft-1' })?.baseHash).toBeNull()
    expect(store().read({ draftId: 'draft-1' })?.content).toBe('x')
    // Not reachable by name — that key space belongs to edit mode only, from here on.
    expect(store().read({ kind: 'skill', name: 'brand-new' })).toBeNull()
  })

  it('returns null rather than throwing on a corrupt draft file', () => {
    fs.mkdirSync(path.join(home, 'drafts'), { recursive: true })
    fs.writeFileSync(file('skill', 'my-skill'), '{not json', 'utf8')
    expect(store().read({ kind: 'skill', name: 'my-skill' })).toBeNull()
  })

  it('returns null rather than throwing on a draft file missing its content', () => {
    fs.mkdirSync(path.join(home, 'drafts'), { recursive: true })
    fs.writeFileSync(file('skill', 'my-skill'), JSON.stringify({ kind: 'skill' }), 'utf8')
    expect(store().read({ kind: 'skill', name: 'my-skill' })).toBeNull()
  })
})

// The regression test for the reported defect: keying create-mode drafts by the typed name meant
// every keystroke in the name field was a rename, and a second create draft that happened to land
// on the same name silently overwrote the first's pending copy. This must fail against a
// name-keyed store — two `queue()` calls for different drafts that share a `name` collide on the
// same key — and pass once create mode keys by `draftId`.
describe('DraftStore create-mode identity (draft-id-rekey)', () => {
  it('two create drafts with the same name coexist on disk; neither overwrites the other', () => {
    const s = store()
    s.queue({
      kind: 'skill',
      name: 'shared',
      mode: 'create',
      content: 'first',
      baseHash: null,
      draftId: 'draft-a'
    })
    s.flushAll()
    s.queue({
      kind: 'skill',
      name: 'shared',
      mode: 'create',
      content: 'second',
      baseHash: null,
      draftId: 'draft-b'
    })
    s.flushAll()

    expect(fs.existsSync(idFile('draft-a'))).toBe(true)
    expect(fs.existsSync(idFile('draft-b'))).toBe(true)
    expect(store().read({ draftId: 'draft-a' })?.content).toBe('first')
    expect(store().read({ draftId: 'draft-b' })?.content).toBe('second')
  })

  it('renaming the name field in create mode does not move the draft to a new key', () => {
    const s = store()
    s.queue({
      kind: 'skill',
      name: 'brand-new',
      mode: 'create',
      content: 'x',
      baseHash: null,
      draftId: 'draft-1'
    })
    s.flushAll()
    const before = fs.existsSync(idFile('draft-1'))

    s.queue({
      kind: 'skill',
      name: 'brand-new2',
      mode: 'create',
      content: 'x2',
      baseHash: null,
      draftId: 'draft-1'
    })
    s.flushAll()

    expect(before).toBe(true)
    // Same key throughout — the record's own `name` field moved, but nothing re-filed it.
    expect(store().read({ draftId: 'draft-1' })?.content).toBe('x2')
    expect(store().read({ draftId: 'draft-1' })?.name).toBe('brand-new2')
  })
})

describe('DraftStore.discard', () => {
  it('removes the file', () => {
    const s = store()
    s.queue(CHANGE)
    s.flushAll()
    s.discard({ kind: 'skill', name: 'my-skill' })
    expect(fs.existsSync(file('skill', 'my-skill'))).toBe(false)
    expect(s.read({ kind: 'skill', name: 'my-skill' })).toBeNull()
  })

  it('drops a change queued but not yet written', () => {
    const s = store()
    s.queue(CHANGE)
    s.discard({ kind: 'skill', name: 'my-skill' })
    s.flushAll()
    expect(fs.existsSync(file('skill', 'my-skill'))).toBe(false)
  })

  it('is a no-op when there is no draft', () => {
    expect(() => store().discard({ kind: 'skill', name: 'nothing' })).not.toThrow()
  })

  it('discards a create-mode draft by its draftId', () => {
    const s = store()
    s.queue({
      kind: 'skill',
      name: 'brand-new',
      mode: 'create',
      content: 'x',
      baseHash: null,
      draftId: 'draft-1'
    })
    s.flushAll()
    s.discard({ draftId: 'draft-1' })
    expect(fs.existsSync(idFile('draft-1'))).toBe(false)
    expect(s.read({ draftId: 'draft-1' })).toBeNull()
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

    s.discard({ kind: 'skill', name: 'my-skill' })
    expect(fs.existsSync(tmp)).toBe(false)
    expect(fs.existsSync(file('skill', 'my-skill'))).toBe(false)
  })

  it('discarding a draft with no stray .tmp file is still a no-op', () => {
    const s = store()
    s.queue(CHANGE)
    s.flushAll()
    expect(() => s.discard({ kind: 'skill', name: 'my-skill' })).not.toThrow()
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
    expect(store().read({ kind: 'skill', name: 'my-skill' })?.content).toBe('# typing\n')
    expect(store().read({ kind: 'reference', name: 'notes.md' })?.content).toBe('r')
  })

  it('flushAll writes the pending change immediately and cancels its timer', () => {
    const seen: DraftRecord[] = []
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    s.onSaved((r) => seen.push(r))
    s.queue(CHANGE)
    s.flushAll()
    expect(store().read({ kind: 'skill', name: 'my-skill' })?.content).toBe('# typing\n')
    // The cancelled timer must not fire a second write after the flush.
    vi.advanceTimersByTime(2000)
    expect(seen).toHaveLength(1)
  })

  it('flushAll on an empty store is a no-op', () => {
    const s = new DraftStore({ argusHome: home, now: () => NOW, debounceMs: 500 })
    expect(() => s.flushAll()).not.toThrow()
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

  it('includes create-mode drafts, carrying their draftId', () => {
    const s = store()
    s.queue({
      kind: 'skill',
      name: 'brand-new',
      mode: 'create',
      content: 'x',
      baseHash: null,
      draftId: 'draft-1'
    })
    s.flushAll()
    const rec = store()
      .list()
      .find((r) => r.name === 'brand-new')
    expect(rec?.draftId).toBe('draft-1')
  })
})

// Finding 1 (data-loss): adoption used to be a renderer-driven "queue the new key (debounced),
// then delete the old one immediately" pair, which left a window — up to `debounceMs` wide,
// unbounded if the write kept failing — where the content lived only in `pending`, nowhere on
// disk. `adopt()` fixes the ordering by doing the whole thing in main: queue, write *that key
// only* synchronously, and discard the legacy key only once the write actually lands.
describe('DraftStore.adopt', () => {
  const legacyChange: DraftChange = {
    kind: 'skill',
    name: 'legacy-skill',
    mode: 'create',
    content: 'legacy content',
    baseHash: null
  }

  it('moves a legacy record onto its draftId key: new key on disk, legacy key gone, content intact', () => {
    const s = store()
    s.queue(legacyChange)
    s.flushAll()
    expect(fs.existsSync(file('skill', 'legacy-skill'))).toBe(true)

    const ok = s.adopt(
      { kind: 'skill', name: 'legacy-skill' },
      { ...legacyChange, draftId: 'new-id' }
    )

    expect(ok).toBe(true)
    expect(fs.existsSync(idFile('new-id'))).toBe(true)
    expect(fs.existsSync(file('skill', 'legacy-skill'))).toBe(false)
    expect(store().read({ draftId: 'new-id' })?.content).toBe('legacy content')
  })

  // The ordering test: this is the regression guard for Finding 1. A "discard-then-write" (or
  // "write-then-discard-regardless-of-success") implementation loses the legacy copy the moment
  // the new write fails. It must still be recoverable.
  it('leaves the legacy file in place when the new write fails', () => {
    const s = store()
    s.queue(legacyChange)
    s.flushAll()
    expect(fs.existsSync(file('skill', 'legacy-skill'))).toBe(true)

    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EPERM: rename failed')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ok = s.adopt(
      { kind: 'skill', name: 'legacy-skill' },
      { ...legacyChange, draftId: 'new-id' }
    )

    renameSpy.mockRestore()
    errSpy.mockRestore()

    expect(ok).toBe(false)
    // The legacy copy is still the only safe copy of these bytes — it must not have been
    // discarded just because the new write failed.
    expect(fs.existsSync(file('skill', 'legacy-skill'))).toBe(true)
    expect(fs.existsSync(idFile('new-id'))).toBe(false)
    // The new record stays queued, so the next keystroke or flushAll() retries it.
    expect(s.read({ draftId: 'new-id' })?.content).toBe('legacy content')
  })

  it('is a no-op on the legacy key when there is nothing queued for the new one to fail on', () => {
    // Sanity: adopt() only ever discards the legacy key through the success path above; a bare
    // call with no prior legacy write must not throw.
    const s = store()
    expect(() =>
      s.adopt({ kind: 'skill', name: 'never-existed' }, { ...legacyChange, draftId: 'fresh-id' })
    ).not.toThrow()
    expect(fs.existsSync(idFile('fresh-id'))).toBe(true)
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
    expect(s.read({ kind: 'skill', name: 'my-skill' })?.content).toBe('# typing\n')

    fs.rmSync(path.join(home, 'drafts'))
    s.flushAll()
    expect(store().read({ kind: 'skill', name: 'my-skill' })?.content).toBe('# typing\n')
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
