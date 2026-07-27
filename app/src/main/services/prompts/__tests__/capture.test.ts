import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PromptCaptureStore, CAPTURE_DIR_REL } from '../capture'
import type { SessionPromptCapture } from '../../../../shared/promptsIpc'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-capture-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function capture(over: Partial<SessionPromptCapture> = {}): SessionPromptCapture {
  return {
    caseSlug: 'c-1',
    sessionId: 1,
    createdAt: '2026-07-27T10:00:00.000Z',
    driverKind: 'claude-agent-sdk',
    model: 'claude-opus-5',
    mode: 'investigation',
    permissionMode: 'default',
    transport: 'systemPrompt.append',
    systemAppend: 'PERSONA TEXT',
    fragments: [{ id: 'persona.neutral', label: 'persona.neutral', chars: 12, overridden: false }],
    skillIndex: '',
    memoryIndex: '',
    enabledSkills: [],
    tools: [],
    activeOverrides: [],
    ...over
  }
}

describe('PromptCaptureStore — gate', () => {
  it('writes nothing, and creates no directory, when the gate is off', () => {
    const store = new PromptCaptureStore({ devTools: false, argusHome: home })
    expect(store.enabled).toBe(false)
    store.record(capture())
    expect(fs.existsSync(path.join(home, CAPTURE_DIR_REL))).toBe(false)
    expect(store.list()).toEqual([])
    expect(store.read('c-1', 1)).toBeNull()
  })
})

describe('PromptCaptureStore — record and read back', () => {
  it('writes one file per session and reads it back verbatim', () => {
    const store = new PromptCaptureStore({ devTools: true, argusHome: home })
    const c = capture()
    store.record(c)
    expect(fs.existsSync(path.join(home, CAPTURE_DIR_REL, 'c-1', '1.json'))).toBe(true)
    expect(store.read('c-1', 1)).toEqual(c)
  })

  it('a re-created session overwrites its own record rather than accumulating', () => {
    // Session ids are stable across a resume, and the newest construction is the one that
    // describes the live session. Keeping both would make "what is this session running on?"
    // ambiguous, which is the question the capture exists to answer.
    const store = new PromptCaptureStore({ devTools: true, argusHome: home })
    store.record(capture({ systemAppend: 'FIRST' }))
    store.record(capture({ systemAppend: 'SECOND' }))
    expect(store.read('c-1', 1)?.systemAppend).toBe('SECOND')
    expect(store.list()).toHaveLength(1)
  })

  it('returns null for a case or session that was never captured', () => {
    const store = new PromptCaptureStore({ devTools: true, argusHome: home })
    store.record(capture())
    expect(store.read('c-1', 99)).toBeNull()
    expect(store.read('no-such-case', 1)).toBeNull()
  })

  it('refuses a path-traversing case slug instead of reading outside the capture dir', () => {
    // caseSlug arrives from IPC, which is untyped at runtime.
    const store = new PromptCaptureStore({ devTools: true, argusHome: home })
    expect(store.read('../../config', 1)).toBeNull()
    expect(() => store.record(capture({ caseSlug: '../escape' }))).toThrow(/case slug/i)
  })

  it('refuses a bare ".." or "." case slug even though it matches the character class', () => {
    // SAFE_SLUG allows `.`, so a dots-only slug passes the regex; `path.join(root, '..')`
    // still escapes the capture dir entirely, so it needs its own explicit rejection.
    const store = new PromptCaptureStore({ devTools: true, argusHome: home })
    expect(store.read('..', 1)).toBeNull()
    expect(store.read('.', 1)).toBeNull()
    expect(() => store.record(capture({ caseSlug: '..' }))).toThrow(/case slug/i)
    expect(() => store.record(capture({ caseSlug: '.' }))).toThrow(/case slug/i)
  })

  it('refuses a non-integer, negative, or non-finite session id', () => {
    // sessionId is interpolated straight into a path segment with no other sanitization, and
    // (like caseSlug) arrives off IPC untyped at runtime.
    const store = new PromptCaptureStore({ devTools: true, argusHome: home })
    store.record(capture({ sessionId: 1 }))
    for (const bad of ['../../config' as unknown as number, -1, 1.5, NaN, Infinity]) {
      expect(store.read('c-1', bad)).toBeNull()
      expect(() => store.record(capture({ sessionId: bad }))).toThrow(/session id/i)
    }
  })
})

describe('PromptCaptureStore — ring buffer', () => {
  it('keeps only the newest N sessions per case', () => {
    const store = new PromptCaptureStore({ devTools: true, argusHome: home, max: 3 })
    for (const id of [1, 2, 3, 4, 5]) store.record(capture({ sessionId: id }))
    const ids = fs
      .readdirSync(path.join(home, CAPTURE_DIR_REL, 'c-1'))
      .map((f) => Number(f.replace('.json', '')))
      .sort((a, b) => a - b)
    expect(ids).toEqual([3, 4, 5])
  })

  it('evicts per case, not globally', () => {
    const store = new PromptCaptureStore({ devTools: true, argusHome: home, max: 2 })
    for (const id of [1, 2, 3]) store.record(capture({ caseSlug: 'c-1', sessionId: id }))
    store.record(capture({ caseSlug: 'c-2', sessionId: 9 }))
    expect(store.read('c-2', 9)).not.toBeNull()
    expect(store.read('c-1', 1)).toBeNull()
    expect(store.read('c-1', 3)).not.toBeNull()
  })
})

describe('PromptCaptureStore — list', () => {
  it('summarises across cases, newest first', () => {
    const store = new PromptCaptureStore({ devTools: true, argusHome: home })
    store.record(capture({ caseSlug: 'c-1', sessionId: 1, createdAt: '2026-07-27T10:00:00.000Z' }))
    store.record(capture({ caseSlug: 'c-2', sessionId: 2, createdAt: '2026-07-27T12:00:00.000Z' }))
    const rows = store.list()
    expect(rows.map((r) => r.sessionId)).toEqual([2, 1])
    expect(rows[0]).toMatchObject({
      caseSlug: 'c-2',
      driverKind: 'claude-agent-sdk',
      mode: 'investigation',
      transport: 'systemPrompt.append',
      chars: 'PERSONA TEXT'.length,
      overrideCount: 0
    })
  })

  it('honours the limit', () => {
    const store = new PromptCaptureStore({ devTools: true, argusHome: home })
    for (const id of [1, 2, 3]) store.record(capture({ sessionId: id }))
    expect(store.list(2)).toHaveLength(2)
  })

  it('counts active overrides in the summary', () => {
    const store = new PromptCaptureStore({ devTools: true, argusHome: home })
    store.record(capture({ activeOverrides: ['persona.neutral', 'persona.diagram'] }))
    expect(store.list()[0].overrideCount).toBe(2)
  })

  it('skips an unreadable or malformed file instead of throwing', () => {
    // A half-written file (app killed mid-record) must not take the whole tab down.
    const store = new PromptCaptureStore({ devTools: true, argusHome: home })
    store.record(capture({ sessionId: 1 }))
    fs.writeFileSync(path.join(home, CAPTURE_DIR_REL, 'c-1', '2.json'), '{ not json', 'utf8')
    expect(store.list().map((r) => r.sessionId)).toEqual([1])
    expect(store.read('c-1', 2)).toBeNull()
  })
})
