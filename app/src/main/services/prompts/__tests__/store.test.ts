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
