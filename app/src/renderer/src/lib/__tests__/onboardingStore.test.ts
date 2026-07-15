// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isFirstRun, markPhase1Done, markIntegration } from '../onboardingStore'
import { settingsStore } from '../settingsStore'
import { defaultSettings } from '../../../../shared/settings'

describe('onboardingStore', () => {
  beforeEach(() => {
    window.argus = {
      settings: { patch: vi.fn(async (p) => ({ settings: defaultSettings(), resolvedTools: [], dataRoot: { path: '', fromEnv: false }, loadError: null, ...p })) }
    } as never
    settingsStore.reset()
  })

  it('first run only when never completed and no cases', () => {
    const s = defaultSettings()
    expect(isFirstRun(s, 0)).toBe(true)
    expect(isFirstRun(s, 3)).toBe(false)
    const done = { ...s, onboarding: { ...s.onboarding, completedAt: '2026-07-15T00:00:00Z' } }
    expect(isFirstRun(done, 0)).toBe(false)
  })

  it('markPhase1Done patches phase1Done + slug', async () => {
    const spy = vi.spyOn(settingsStore, 'patch').mockResolvedValue()
    await markPhase1Done('sample-onboarding')
    expect(spy).toHaveBeenCalledWith({
      onboarding: { phase1Done: true, sampleCaseSlug: 'sample-onboarding' }
    })
  })

  it('markIntegration patches the right flag', async () => {
    const spy = vi.spyOn(settingsStore, 'patch').mockResolvedValue()
    await markIntegration('confluence', true)
    expect(spy).toHaveBeenCalledWith({ onboarding: { integrations: { confluence: true } } })
  })
})
