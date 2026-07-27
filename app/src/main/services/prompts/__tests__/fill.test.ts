import { describe, it, expect } from 'vitest'
import { fillPrompt } from '../fill'
import { specEntries } from '../registry'

describe('fillPrompt', () => {
  it('substitutes every declared placeholder', () => {
    expect(fillPrompt('line {from} of {total}', { from: '5', total: '900' })).toBe('line 5 of 900')
  })

  it('substitutes a placeholder used more than once', () => {
    expect(fillPrompt('{x} then {x}', { x: 'a' })).toBe('a then a')
  })

  it('leaves an unknown token literal rather than blanking it', () => {
    // A blanked token silently deletes text from a model-facing message; a literal one is
    // visible in the output and in any transcript, so the mistake is findable.
    expect(fillPrompt('keep {unknown} here', { other: 'x' })).toBe('keep {unknown} here')
  })

  it('leaves text with no placeholders untouched', () => {
    expect(fillPrompt('no tokens at all', { a: 'b' })).toBe('no tokens at all')
  })

  it('does not treat a JSON-looking brace as a placeholder', () => {
    // Prompt bodies contain JSON examples like { "summary": ... }. Only \\w+ between braces
    // with no spaces is a placeholder.
    expect(fillPrompt('{ "summary": 1 }', { summary: 'X' })).toBe('{ "summary": 1 }')
  })
})

describe('specEntries', () => {
  const SPECS = {
    'a.one': { title: 'First', text: 'plain text' },
    'b.two': { title: 'Second', text: 'has {slot}', placeholders: ['slot'] as const }
  }

  it('derives one entry per spec key, prefixed and categorised', () => {
    const entries = specEntries(SPECS, {
      prefix: 'tool-feedback',
      category: 'tool-feedback',
      source: 'app/src/main/services/agent/nativeTools.ts',
      reaches: ['claude-agent-sdk']
    })
    expect(entries.map((e) => e.id)).toEqual(['tool-feedback.a.one', 'tool-feedback.b.two'])
    expect(entries[0].title).toBe('First')
    expect(entries[0].default()).toBe('plain text')
    expect(entries[0].editable).toBe(true)
    expect(entries[0].category).toBe('tool-feedback')
    expect(entries[0].reaches).toEqual(['claude-agent-sdk'])
    expect(entries[0].source).toBe('app/src/main/services/agent/nativeTools.ts')
  })

  it('carries placeholders through, and omits the key when there are none', () => {
    const entries = specEntries(SPECS, {
      prefix: 'tool-feedback',
      category: 'tool-feedback',
      source: 'app/src/main/services/agent/nativeTools.ts',
      reaches: 'all'
    })
    expect(entries[0].placeholders).toBeUndefined()
    expect(entries[1].placeholders).toEqual(['slot'])
  })
})
