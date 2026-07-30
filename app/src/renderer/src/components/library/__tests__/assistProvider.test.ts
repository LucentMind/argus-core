import { describe, it, expect } from 'vitest'
import { assistProviderLabel } from '../assistProvider'
import { getDriver } from '../../../../../shared/drivers'
import type { AppSettings } from '../../../../../shared/settings'

/** Minimal AppSettings shaped just for resolveDistillProvider. */
function settingsWith(over: Record<string, unknown>): AppSettings {
  return {
    agent: { providerInstances: {}, modelPreferences: {}, ...over }
  } as unknown as AppSettings
}

/** Every catalog model of a driver, so a fixture can hide them all and leave `model` unresolved. */
function allSlugs(driver: string): string[] {
  return (getDriver(driver)?.models ?? []).map((m) => m.slug)
}

describe('assistProviderLabel', () => {
  it('names the driver and model of the explicitly configured distill provider', () => {
    const r = assistProviderLabel(
      settingsWith({
        distillProvider: { instanceId: 'claude-1', model: 'claude-sonnet-4-5' },
        providerInstances: {
          'claude-1': { driver: 'claude-agent-sdk', enabled: true, config: {} }
        }
      })
    )
    expect(r).toEqual({ ok: true, text: 'via claude-agent-sdk · claude-sonnet-4-5' })
  })

  it('names the driver alone when no model resolves', () => {
    const r = assistProviderLabel(
      settingsWith({
        distillProvider: { instanceId: 'claude-1' },
        providerInstances: {
          'claude-1': { driver: 'claude-agent-sdk', enabled: true, config: {} }
        },
        // No explicit model and no config.model, so the resolver falls back to the first
        // *visible* catalog model — hide them all and that fallback misses too, which is the
        // only way `model` comes back undefined for an enabled instance.
        modelPreferences: {
          'claude-1': {
            hiddenModels: allSlugs('claude-agent-sdk'),
            favoriteModels: [],
            modelOrder: []
          }
        }
      })
    )
    expect(r).toEqual({ ok: true, text: 'via claude-agent-sdk' })
  })

  it('reports the resolver reason when nothing is configured', () => {
    const r = assistProviderLabel(settingsWith({}))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no provider configured/i)
  })

  it('reports the resolver reason when the named provider is disabled', () => {
    const r = assistProviderLabel(
      settingsWith({
        distillProvider: { instanceId: 'off-1' },
        providerInstances: { 'off-1': { driver: 'claude-agent-sdk', enabled: false, config: {} } }
      })
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown or disabled/i)
  })
})
