import { describe, it, expect } from 'vitest'
import models from '../__fixtures__/models-2-1-220.json'

describe('captured claude catalog fixture', () => {
  it('resolves the opus alias to Opus 5 (the reason the SDK floor is 0.3.220)', () => {
    const opus = models.find((m) => m.value === 'opus[1m]')
    expect(opus?.resolvedModel).toBe('claude-opus-5[1m]')
  })

  it('carries the option-bearing fields the descriptors are derived from', () => {
    const fable = models.find((m) => m.value === 'fable')
    expect(fable?.supportsEffort).toBe(true)
    expect(fable?.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(fable?.supportsFastMode).toBeFalsy()
  })

  it('has a model with no options at all, so the empty case is covered', () => {
    const haiku = models.find((m) => m.value === 'haiku')
    expect(haiku?.supportsEffort).toBeFalsy()
    expect(haiku?.supportsAdaptiveThinking).toBeFalsy()
  })
})
