import { describe, it, expect } from 'vitest'
import models from '../__fixtures__/models-2-1-220.json'
import models263 from '../__fixtures__/models-2-1-263.json'
import models281 from '../__fixtures__/models-2-1-281.json'
import models281Entitled from '../__fixtures__/models-2-1-281-entitled.json'

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

// Captured from SDK 0.3.281 (CLI 2.1.281); date and probe turns in EVIDENCE.md. The floor
// moved because the API gates Opus 5.5 on the CLI version (spec 2026-09-24-opus-5-5-model-design).
describe('captured claude catalog fixture — 2.1.281', () => {
  it('keys the default and opus aliases to Opus 5.5 (1M), the reason the SDK floor is 0.3.281', () => {
    expect(models281.find((m) => m.value === 'default')?.resolvedModel).toBe('claude-opus-5-5[1m]')
    expect(models281.find((m) => m.value === 'opus[1m]')?.resolvedModel).toBe('claude-opus-5-5[1m]')
  })

  it('no longer names Opus 5 in the alias menu, so its static row must survive the merge', () => {
    expect(
      models281.some(
        (m) => m.resolvedModel === 'claude-opus-5' || m.resolvedModel === 'claude-opus-5[1m]'
      )
    ).toBe(false)
  })

  // Fable arrives as a wire-slug row (`claude-fable-5-1[1m]` → bare), not a `fable` alias: the
  // shape EVIDENCE.md first saw once on 2.1.263, here on every alias-menu read.
  it('still offers Fable 5.1 and Sonnet 5', () => {
    expect(models281.find((m) => m.resolvedModel === 'claude-fable-5-1')?.value).toBe(
      'claude-fable-5-1[1m]'
    )
    expect(models281.find((m) => m.value === 'sonnet')?.resolvedModel).toBe('claude-sonnet-5')
  })

  it('reports every effort level and fast mode for Opus 5.5', () => {
    const opus = models281.find((m) => m.value === 'opus[1m]')
    expect(opus?.supportsEffort).toBe(true)
    expect(opus?.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(opus?.supportsFastMode).toBe(true)
  })
})

// The same CLI on the same account, once its bootstrap has cached the org's model access:
// the catalog becomes the entitlement list (EVIDENCE.md). `default` is no longer Opus.
describe('captured claude catalog fixture — 2.1.281 entitlement list', () => {
  it('keys default to Sonnet 5 and the bare opus alias to Opus 5.5 (no [1m])', () => {
    expect(models281Entitled.find((m) => m.value === 'default')?.resolvedModel).toBe(
      'claude-sonnet-5'
    )
    expect(models281Entitled.find((m) => m.value === 'opus')?.resolvedModel).toBe('claude-opus-5-5')
  })

  it('lists Opus 5 as its own wire-slug row', () => {
    expect(models281Entitled.find((m) => m.value === 'claude-opus-5')?.resolvedModel).toBe(
      'claude-opus-5'
    )
  })

  it('reports every effort level and fast mode for Opus 5.5', () => {
    const opus = models281Entitled.find((m) => m.value === 'opus')
    expect(opus?.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(opus?.supportsFastMode).toBe(true)
  })
})
