import { describe, it, expect } from 'vitest'
import { overrideBootWarnings } from '../bootWarnings'

describe('overrideBootWarnings', () => {
  it('is silent when there are no overrides and no load error', () => {
    expect(overrideBootWarnings({ ids: [], loadError: null })).toEqual([])
  })

  it('names the active overrides when some are set', () => {
    const warnings = overrideBootWarnings({
      ids: ['persona.diagram', 'persona.neutral'],
      loadError: null
    })
    expect(warnings).toEqual([
      '[prompts] 2 prompt override(s) ACTIVE — the agent is not running on built-in prompts: persona.diagram, persona.neutral'
    ])
  })

  it('reports a load error even with no active overrides', () => {
    const warnings = overrideBootWarnings({
      ids: [],
      loadError: 'Unexpected token n in JSON at position 2'
    })
    expect(warnings).toEqual([
      '[prompts] override file could not be parsed, using defaults: Unexpected token n in JSON at position 2'
    ])
  })

  it('emits both messages when overrides are active and the file also failed to parse', () => {
    // Not mutually exclusive: a malformed file falls back to {} (no overrides parsed from IT),
    // but an id can still be "active" via... in practice these are usually exclusive, but the
    // function must not assume that — it reports exactly what it's told, independently.
    const warnings = overrideBootWarnings({ ids: ['persona.neutral'], loadError: 'bad json' })
    expect(warnings).toEqual([
      '[prompts] 1 prompt override(s) ACTIVE — the agent is not running on built-in prompts: persona.neutral',
      '[prompts] override file could not be parsed, using defaults: bad json'
    ])
  })
})
