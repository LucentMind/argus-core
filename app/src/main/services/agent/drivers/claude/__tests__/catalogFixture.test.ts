import { describe, it, expect } from 'vitest'
import models from '../__fixtures__/models-2-1-220.json'
import models263 from '../__fixtures__/models-2-1-263.json'

describe('captured claude catalog fixture', () => {
  it('resolves the opus alias to Opus 5 (the reason the SDK floor was raised to 0.3.220)', () => {
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

// Captured 2026-09-07 from SDK 0.3.263 (CLI 2.1.263). The floor moved because the API gates
// Fable 5.1 on the CLI version: on 2.1.220 the slug returned HTTP 400 "Claude Code 2.1.220
// does not support this model; version 2.1.251 or newer is required". See EVIDENCE.md.
describe('captured claude catalog fixture — 2.1.263', () => {
  it('resolves the fable alias to Fable 5.1 (the reason the SDK floor is 0.3.263)', () => {
    const fable = models263.find((m) => m.value === 'fable')
    expect(fable?.resolvedModel).toBe('claude-fable-5-1')
    expect(fable?.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(fable?.supportsAdaptiveThinking).toBe(true)
    expect(fable?.supportsFastMode).toBeFalsy()
  })

  it('no longer names Fable 5 in the alias menu, so its static row must survive the merge', () => {
    expect(models263.some((m) => m.resolvedModel === 'claude-fable-5')).toBe(false)
  })

  it('still keys the default and opus aliases to the same Opus 5 (1M) model', () => {
    expect(models263.find((m) => m.value === 'default')?.resolvedModel).toBe('claude-opus-5[1m]')
    expect(models263.find((m) => m.value === 'opus[1m]')?.resolvedModel).toBe('claude-opus-5[1m]')
  })
})
