import { describe, it, expect } from 'vitest'
import {
  DRIVERS,
  getDriver,
  driverConfig,
  activeInstanceConfig,
  instanceModels,
  orderedVisibleModels,
  orderedModels,
  effectiveDefaultModel,
  activeDriver,
  activeCapabilities,
  type ClaudeDriverConfig
} from '../drivers'
import { settingsSchema, type AppSettings } from '../settings'

const CATALOG_ORDER = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5'
]

function withPrefs(
  prefs?: { hiddenModels?: string[]; favoriteModels?: string[]; modelOrder?: string[] },
  config?: Record<string, unknown>
): AppSettings {
  return settingsSchema.parse({
    agent: {
      activeInstanceId: 'claude-default',
      providerInstances: {
        'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: config ?? {} }
      },
      modelPreferences: prefs ? { 'claude-default': prefs } : {}
    }
  })
}

describe('driver registry', () => {
  it('has claude-agent-sdk with ordered form annotations', () => {
    const d = getDriver('claude-agent-sdk')!
    expect(d.label).toBe('Claude Agent SDK')
    const orders = Object.values(d.formAnnotations).map((a) => a.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('no built-in agent driver sets sensitive (only connector forms use it)', () => {
    for (const d of Object.values(DRIVERS))
      for (const a of Object.values(d.formAnnotations)) expect(a.sensitive).toBeFalsy()
  })

  it('driverConfig validates and passes through; unknown slug or bad config → {}', () => {
    expect(
      driverConfig<ClaudeDriverConfig>('claude-agent-sdk', { model: 'claude-sonnet-5' })
    ).toEqual({ model: 'claude-sonnet-5' })
    expect(driverConfig('claude-agent-sdk', { model: 42 })).toEqual({})
    expect(driverConfig('no-such-driver', { anything: true })).toEqual({})
    expect(getDriver('no-such-driver')).toBeNull()
  })

  it('activeInstanceConfig resolves the enabled active instance', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'claude-default',
        providerInstances: {
          'claude-default': {
            driver: 'claude-agent-sdk',
            enabled: true,
            config: { model: 'claude-opus-4-8' }
          }
        }
      }
    })
    expect(activeInstanceConfig(s)).toEqual({ model: 'claude-opus-4-8' })
    const off = settingsSchema.parse({
      agent: {
        providerInstances: {
          'claude-default': { driver: 'claude-agent-sdk', enabled: false, config: { model: 'x' } }
        }
      }
    })
    expect(activeInstanceConfig(off)).toEqual({})
  })

  it('model is not a form-annotated field (rendered by ProviderModels instead)', () => {
    const d = getDriver('claude-agent-sdk')!
    expect(d.formAnnotations.model).toBeUndefined()
    expect(d.formAnnotations.cliPath).toBeTruthy()
  })

  it('claude-agent-sdk carries the static built-in model catalog', () => {
    const d = getDriver('claude-agent-sdk')!
    expect(d.models.map((m) => m.slug)).toEqual(CATALOG_ORDER)
    expect(d.models.every((m) => !m.isCustom)).toBe(true)
  })

  it('claude-agent-sdk capabilities: all four permission modes, editable approvals, cost reporting, no plan flag', () => {
    const d = getDriver('claude-agent-sdk')!
    expect(d.capabilities.permissionModes).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions'
    ])
    expect(d.capabilities.editableApprovals).toBe(true)
    expect(d.capabilities.costReporting).toBe(true)
    expect(d.capabilities.planMode).toBeUndefined()
  })

  it('has github-copilot with an accepting config schema and a non-empty model list', () => {
    const d = getDriver('github-copilot')!
    expect(d.label).toBe('GitHub Copilot')
    expect(d.shortLabel).toBe('Copilot')
    const parsed = d.configSchema.safeParse({ model: 'x', cliPath: 'y' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toMatchObject({ model: 'x', cliPath: 'y' })
    expect(d.models.length).toBeGreaterThan(0)
  })

  it('github-copilot models: free tier is auto-only (Task 7 evidence, 09-models.jsonl)', () => {
    const d = getDriver('github-copilot')!
    expect(d.models).toEqual([{ slug: 'auto', name: 'Auto' }])
  })

  it('github-copilot capabilities: all four permission modes, plan mode supported, no editable approvals/cost reporting', () => {
    const d = getDriver('github-copilot')!
    expect(d.capabilities.permissionModes).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions'
    ])
    expect(d.capabilities.editableApprovals).toBe(false)
    expect(d.capabilities.costReporting).toBe(false)
    expect(d.capabilities.planMode).toBe(true)
  })

  it('activeDriver resolves the active instance driver; null for unknown slug', () => {
    expect(activeDriver(withPrefs())?.kind).toBe('claude-agent-sdk')
    const s = withPrefs()
    s.agent.providerInstances['claude-default'].driver = 'mystery-driver'
    expect(activeDriver(s)).toBeNull()
  })

  it('activeCapabilities returns the active driver capabilities when settings resolve', () => {
    expect(activeCapabilities(withPrefs())).toBe(DRIVERS['claude-agent-sdk'].capabilities)
    const s = withPrefs()
    s.agent.providerInstances['claude-default'].driver = 'github-copilot'
    expect(activeCapabilities(s)).toBe(DRIVERS['github-copilot'].capabilities)
  })

  it('activeCapabilities fallback (null settings / unknown driver) is conservative on editableApprovals only', () => {
    // The fallback covers both the pre-load window AND the settled state where
    // settings IPC failed (SettingsStore.start swallows the error and the payload
    // stays null forever). Cosmetic fields stay permissive; the security-relevant
    // edit affordance must not be offered when the driver is unknown.
    for (const caps of [
      activeCapabilities(null),
      activeCapabilities(undefined),
      (() => {
        const s = withPrefs()
        s.agent.providerInstances['claude-default'].driver = 'mystery-driver'
        return activeCapabilities(s)
      })()
    ]) {
      expect(caps.permissionModes).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
      expect(caps.editableApprovals).toBe(false)
      expect(caps.costReporting).toBe(true)
    }
  })

  it('both driver configs accept the shared {model?, cliPath?, customModels?} shape', () => {
    for (const slug of ['claude-agent-sdk', 'github-copilot']) {
      const d = getDriver(slug)!
      const parsed = d.configSchema.safeParse({
        model: 'm',
        cliPath: 'p',
        customModels: ['a', 'b']
      })
      expect(parsed.success).toBe(true)
    }
  })
})

describe('github-copilot activeInstanceConfig', () => {
  it('resolves the config of an enabled copilot active instance', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'copilot-default',
        providerInstances: {
          'copilot-default': {
            driver: 'github-copilot',
            enabled: true,
            config: { model: 'auto', cliPath: '/usr/local/bin/copilot' }
          }
        }
      }
    })
    expect(activeInstanceConfig(s)).toEqual({ model: 'auto', cliPath: '/usr/local/bin/copilot' })
  })
})

describe('model ordering helpers', () => {
  it('instanceModels returns the catalog unmodified with no custom models', () => {
    expect(instanceModels(withPrefs()).map((m) => m.slug)).toEqual(CATALOG_ORDER)
  })

  it('instanceModels appends custom models, flagged, deduped against the catalog and each other', () => {
    const s = withPrefs(undefined, {
      customModels: ['my-finetune', 'claude-sonnet-5', 'my-finetune']
    })
    const models = instanceModels(s)
    expect(models.map((m) => m.slug)).toEqual([...CATALOG_ORDER, 'my-finetune'])
    expect(models.find((m) => m.slug === 'my-finetune')?.isCustom).toBe(true)
    expect(models.find((m) => m.slug === 'claude-sonnet-5')?.isCustom).toBeFalsy()
  })

  it('orderedVisibleModels with no prefs preserves original catalog order', () => {
    expect(orderedVisibleModels(withPrefs()).map((m) => m.slug)).toEqual(CATALOG_ORDER)
  })

  it('favorites are grouped first, ahead of everything else', () => {
    const s = withPrefs({ favoriteModels: ['claude-haiku-4-5'] })
    const slugs = orderedVisibleModels(s).map((m) => m.slug)
    expect(slugs[0]).toBe('claude-haiku-4-5')
    expect(slugs.slice(1)).toEqual(CATALOG_ORDER.filter((s) => s !== 'claude-haiku-4-5'))
  })

  it('modelOrder ranks within a group, falling back to original order for unranked models', () => {
    const s = withPrefs({ modelOrder: ['claude-sonnet-5', 'claude-opus-4-8'] })
    const slugs = orderedVisibleModels(s).map((m) => m.slug)
    expect(slugs.slice(0, 2)).toEqual(['claude-sonnet-5', 'claude-opus-4-8'])
    expect(slugs.slice(2)).toEqual(
      CATALOG_ORDER.filter((s) => s !== 'claude-sonnet-5' && s !== 'claude-opus-4-8')
    )
  })

  it('favorites win over modelOrder for grouping; modelOrder ranks within the favorites group', () => {
    const s = withPrefs({
      favoriteModels: ['claude-opus-4-8', 'claude-haiku-4-5'],
      modelOrder: ['claude-haiku-4-5', 'claude-opus-4-8']
    })
    const slugs = orderedVisibleModels(s).map((m) => m.slug)
    expect(slugs.slice(0, 2)).toEqual(['claude-haiku-4-5', 'claude-opus-4-8'])
  })

  it('hidden models are excluded from orderedVisibleModels but present in orderedModels', () => {
    const s = withPrefs({ hiddenModels: ['claude-opus-4-7'] })
    expect(orderedVisibleModels(s).map((m) => m.slug)).not.toContain('claude-opus-4-7')
    expect(orderedModels(s).map((m) => m.slug)).toContain('claude-opus-4-7')
    expect(orderedModels(s).map((m) => m.slug)).toEqual(CATALOG_ORDER)
  })

  it('effectiveDefaultModel: explicit config.model wins over ordering', () => {
    const s = withPrefs({ favoriteModels: ['claude-haiku-4-5'] }, { model: 'claude-opus-4-7' })
    expect(effectiveDefaultModel(s)).toBe('claude-opus-4-7')
  })

  it('effectiveDefaultModel: falls back to the top ordered visible model with no config.model', () => {
    const s = withPrefs({ favoriteModels: ['claude-haiku-4-5'] })
    expect(effectiveDefaultModel(s)).toBe('claude-haiku-4-5')
  })

  it('effectiveDefaultModel: undefined when the active instance is disabled (matches activeInstanceConfig gate)', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'claude-default',
        providerInstances: {
          'claude-default': { driver: 'claude-agent-sdk', enabled: false, config: {} }
        }
      }
    })
    expect(instanceModels(s)).toEqual([])
    expect(effectiveDefaultModel(s)).toBeUndefined()
  })

  it('effectiveDefaultModel: undefined when the instance has no models and no config.model', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'claude-default',
        providerInstances: {
          'claude-default': { driver: 'no-such-driver', enabled: true, config: {} }
        }
      }
    })
    expect(effectiveDefaultModel(s)).toBeUndefined()
  })
})
