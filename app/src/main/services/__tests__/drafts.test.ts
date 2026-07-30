import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
