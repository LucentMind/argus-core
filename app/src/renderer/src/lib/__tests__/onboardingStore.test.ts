// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shouldOpenOnboarding, markPhase1Done, markIntegration } from '../onboardingStore'
import { settingsStore } from '../settingsStore'
import { defaultSettings } from '../../../../shared/settings'

describe('onboardingStore', () => {
  beforeEach(() => {
    window.argus = {
      settings: {
        patch: vi.fn(async (p) => ({
          settings: defaultSettings(),
          resolvedTools: [],
          dataRoot: { path: '', fromEnv: false },
          loadError: null,
          ...p
        }))
      }
    } as never
    settingsStore.reset()
  })

  it('opens on true first run: never completed, no cases, phase1 not done', () => {
    const s = defaultSettings()
    expect(shouldOpenOnboarding(s, 0)).toBe(true)
  })

  it('stays closed for an existing user: never completed, has cases, phase1 not done', () => {
    const s = defaultSettings()
    expect(shouldOpenOnboarding(s, 3)).toBe(false)
  })

  it('re-opens on replay: never completed, has cases, phase1 already done', () => {
    const s = defaultSettings()
    const replay = { ...s, onboarding: { ...s.onboarding, phase1Done: true } }
    expect(shouldOpenOnboarding(replay, 3)).toBe(true)
  })

  it('stays closed once completed, regardless of case count or phase1Done', () => {
    const s = defaultSettings()
    const done = { ...s, onboarding: { ...s.onboarding, completedAt: '2026-07-15T00:00:00Z' } }
    expect(shouldOpenOnboarding(done, 0)).toBe(false)
    const doneWithCases = {
      ...s,
      onboarding: { ...s.onboarding, completedAt: '2026-07-15T00:00:00Z', phase1Done: true }
    }
    expect(shouldOpenOnboarding(doneWithCases, 5)).toBe(false)
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
