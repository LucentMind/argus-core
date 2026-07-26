import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { PromptStore } from '../store'
import { NEUTRAL_PERSONA } from '../../agent/persona'
import { PROMPT_ENTRIES } from '../registry'

describe('PromptStore', () => {
  it('resolves a known id to its default', () => {
    const store = new PromptStore({ devTools: true })
    expect(store.resolve('persona.neutral')).toBe(NEUTRAL_PERSONA)
  })

  it('resolves the same default whether or not the gate is on', () => {
    // Plan 1 has no overrides, so the gate cannot change resolution yet. Asserted so Plan 3
    // has to state explicitly what it changes.
    const on = new PromptStore({ devTools: true })
    const off = new PromptStore({ devTools: false })
    expect(off.resolve('persona.neutral')).toBe(on.resolve('persona.neutral'))
  })

  it('throws on an unknown id rather than returning empty text', () => {
    const store = new PromptStore({ devTools: true })
    // Silently returning '' would blank a persona fragment on a typo — fail loudly instead.
    expect(() => store.resolve('nope.not.real')).toThrow(/unknown prompt id/i)
  })

  it('throws when resolving an external entry, which has no text', () => {
    const store = new PromptStore({ devTools: true })
    expect(() => store.resolve('external.claude.preset')).toThrow(/external/i)
  })

  it('catalog exposes one view per entry with sizes and no override', () => {
    const store = new PromptStore({ devTools: true })
    const cat = store.catalog()
    expect(cat.length).toBe(PROMPT_ENTRIES.length)
    const neutral = cat.find((c) => c.id === 'persona.neutral')
    expect(neutral).toMatchObject({
      category: 'persona',
      editable: true,
      overrideText: null,
      chars: NEUTRAL_PERSONA.length
    })
    expect(neutral?.defaultText).toBe(NEUTRAL_PERSONA)
  })

  it('catalog reports external entries as zero-length with their note', () => {
    const store = new PromptStore({ devTools: true })
    const ext = store.catalog().find((c) => c.id === 'external.claude.preset')
    expect(ext).toMatchObject({ chars: 0, editable: false, defaultText: '' })
    expect(ext?.note).toMatch(/claude_code/)
  })

  it('resolveFn returns a bound resolver usable as a plain function', () => {
    const store = new PromptStore({ devTools: true })
    const resolve = store.resolveFn()
    expect(resolve('persona.neutral')).toBe(NEUTRAL_PERSONA)
  })
})

function tmpHome(overrides?: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prompts-'))
  if (overrides) {
    fs.mkdirSync(path.join(home, 'config'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'config', 'dev-prompt-overrides.json'),
      JSON.stringify(overrides, null, 2),
      'utf8'
    )
  }
  return home
}

/** Writes raw bytes, so a malformed file can be exercised. */
function tmpHomeRaw(raw: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prompts-'))
  fs.mkdirSync(path.join(home, 'config'), { recursive: true })
  fs.writeFileSync(path.join(home, 'config', 'dev-prompt-overrides.json'), raw, 'utf8')
  return home
}

describe('PromptStore overrides — read path', () => {
  it('resolves an override instead of the default when the gate is on', () => {
    const home = tmpHome({ 'persona.neutral': 'OVERRIDDEN RULES' })
    const store = new PromptStore({ devTools: true, argusHome: home })
    expect(store.resolve('persona.neutral')).toBe('OVERRIDDEN RULES')
  })

  it('is completely inert when the gate is off — the file is never read', () => {
    // Guard 1. This is the whole safety story: an override file left on a normal machine must
    // not change behavior, so assert the DEFAULT comes back even though the file says otherwise.
    const home = tmpHome({ 'persona.neutral': 'OVERRIDDEN RULES' })
    const store = new PromptStore({ devTools: false, argusHome: home })
    expect(store.resolve('persona.neutral')).toBe(NEUTRAL_PERSONA)
    expect(store.activeOverrideIds()).toEqual([])
  })

  it('reports active override ids, sorted', () => {
    const home = tmpHome({ 'persona.diagram': 'D', 'persona.neutral': 'N' })
    const store = new PromptStore({ devTools: true, argusHome: home })
    expect(store.activeOverrideIds()).toEqual(['persona.diagram', 'persona.neutral'])
  })

  it('drops an override whose id the registry no longer owns', () => {
    // A renamed or deleted entry leaves a stale key behind. Applying text for an id nothing
    // resolves is worse than losing it — and it would otherwise show up in the banner forever.
    const home = tmpHome({ 'persona.neutral': 'KEEP', 'gone.entry': 'STALE' })
    const store = new PromptStore({ devTools: true, argusHome: home })
    expect(store.activeOverrideIds()).toEqual(['persona.neutral'])
  })

  it('drops an override for a read-only entry', () => {
    // external entries have no text of their own; an override here would invent one.
    const home = tmpHome({ 'external.claude.preset': 'INVENTED' })
    const store = new PromptStore({ devTools: true, argusHome: home })
    expect(store.activeOverrideIds()).toEqual([])
    expect(() => store.resolve('external.claude.preset')).toThrow(/external/i)
  })

  it('ignores a non-string value rather than coercing it', () => {
    const home = tmpHome({ 'persona.neutral': 42 })
    const store = new PromptStore({ devTools: true, argusHome: home })
    expect(store.resolve('persona.neutral')).toBe(NEUTRAL_PERSONA)
  })

  it('degrades to defaults and reports a load error on a malformed file', () => {
    const store = new PromptStore({ devTools: true, argusHome: tmpHomeRaw('{ not json') })
    expect(store.resolve('persona.neutral')).toBe(NEUTRAL_PERSONA)
    expect(store.loadError).toBeTruthy()
  })

  it('has no load error and no overrides when the file is absent', () => {
    const store = new PromptStore({ devTools: true, argusHome: tmpHome() })
    expect(store.loadError).toBeNull()
    expect(store.activeOverrideIds()).toEqual([])
  })

  it('catalog reports the override text and sizes the EFFECTIVE text', () => {
    const home = tmpHome({ 'persona.neutral': 'SHORT' })
    const store = new PromptStore({ devTools: true, argusHome: home })
    const view = store.catalog().find((c) => c.id === 'persona.neutral')
    expect(view?.overrideText).toBe('SHORT')
    expect(view?.defaultText).toBe(NEUTRAL_PERSONA)
    // `chars` drives the "how big is my prompt" read on the page — it must describe what the
    // model actually receives, not the default that was replaced.
    expect(view?.chars).toBe('SHORT'.length)
  })

  it('catalogPayload carries the active ids and load error for the banner', () => {
    const home = tmpHome({ 'persona.neutral': 'X' })
    const store = new PromptStore({ devTools: true, argusHome: home })
    expect(store.catalogPayload()).toMatchObject({
      activeOverrideIds: ['persona.neutral'],
      loadError: null
    })
    expect(store.catalogPayload().entries.length).toBe(PROMPT_ENTRIES.length)
  })
})
