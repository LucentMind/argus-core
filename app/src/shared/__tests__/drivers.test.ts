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
  enabledInstances,
  defaultInstanceId,
  allVisibleModels,
  defaultModelRef,
  capabilitiesFor,
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

  it('registers cursor and grok ACP drivers with approval-parity capabilities', () => {
    for (const kind of ['cursor', 'grok'] as const) {
      const d = DRIVERS[kind]
      expect(d).toBeDefined()
      expect(d.capabilities.editableApprovals).toBe(false)
      expect(d.capabilities.headlessOneShot).toBe(false)
      expect(d.capabilities.planMode).toBe(true)
      expect(d.models.length).toBeGreaterThan(0)
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

// ── multi-provider aggregation ────────────────────────────────────────────────

/** Two enabled providers, Claude first in key order. */
function multi(over?: {
  claudeEnabled?: boolean
  copilotEnabled?: boolean
  activeInstanceId?: string
}): AppSettings {
  return settingsSchema.parse({
    agent: {
      activeInstanceId: over?.activeInstanceId ?? 'claude-default',
      providerInstances: {
        'claude-default': {
          driver: 'claude-agent-sdk',
          enabled: over?.claudeEnabled ?? true,
          config: {}
        },
        'copilot-1': {
          driver: 'github-copilot',
          enabled: over?.copilotEnabled ?? true,
          config: {}
        }
      }
    }
  })
}

describe('enabledInstances', () => {
  it('returns every switched-on instance, not just the default one', () => {
    expect(enabledInstances(multi()).map((e) => e.id)).toEqual(['claude-default', 'copilot-1'])
  })

  it('omits disabled instances and instances naming an unknown driver', () => {
    expect(enabledInstances(multi({ copilotEnabled: false })).map((e) => e.id)).toEqual([
      'claude-default'
    ])
    const unknown = settingsSchema.parse({
      agent: {
        activeInstanceId: 'x',
        providerInstances: { x: { driver: 'not-a-driver', enabled: true, config: {} } }
      }
    })
    expect(enabledInstances(unknown)).toEqual([])
  })
})

describe('defaultInstanceId', () => {
  it('uses activeInstanceId when it is enabled and known', () => {
    expect(defaultInstanceId(multi({ activeInstanceId: 'copilot-1' }))).toBe('copilot-1')
  })

  it('falls back to the first enabled instance when the named one is switched off', () => {
    // Background work (distill, refsync, probes) has no picker to fall back to, so
    // disabling the default provider must not strand it.
    expect(defaultInstanceId(multi({ claudeEnabled: false }))).toBe('copilot-1')
  })

  it('falls back when the named instance names an unknown driver', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'ghost',
        providerInstances: {
          ghost: { driver: 'not-a-driver', enabled: true, config: {} },
          'copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
        }
      }
    })
    expect(defaultInstanceId(s)).toBe('copilot-1')
  })

  it('keeps the named id when nothing at all is enabled, rather than inventing one', () => {
    const s = multi({ claudeEnabled: false, copilotEnabled: false })
    expect(defaultInstanceId(s)).toBe('claude-default')
  })
})

describe('allVisibleModels', () => {
  it('aggregates across every enabled provider, each tagged with its instance', () => {
    const models = allVisibleModels(multi())
    expect(models.filter((m) => m.instanceId === 'claude-default').map((m) => m.slug)).toEqual(
      CATALOG_ORDER
    )
    const copilot = models.filter((m) => m.instanceId === 'copilot-1')
    expect(copilot.map((m) => m.slug)).toEqual(['auto'])
    expect(copilot[0].providerLabel).toBe('Copilot')
    expect(copilot[0].driverKind).toBe('github-copilot')
  })

  it('does not dedupe identical slugs across instances — they are distinct choices', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'claude-default',
        providerInstances: {
          'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} },
          'claude-work': {
            driver: 'claude-agent-sdk',
            displayName: 'Work account',
            enabled: true,
            config: {}
          }
        }
      }
    })
    const opus = allVisibleModels(s).filter((m) => m.slug === 'claude-opus-4-8')
    expect(opus).toHaveLength(2)
    expect(opus.map((m) => m.instanceId)).toEqual(['claude-default', 'claude-work'])
    expect(opus[1].providerLabel).toBe('Work account')
  })

  it('excludes a disabled provider’s models', () => {
    expect(allVisibleModels(multi({ copilotEnabled: false })).some((m) => m.slug === 'auto')).toBe(
      false
    )
  })
})

// ── rowOverrides: per-instance catalog substitution ─────────────────────────────
//
// The Composer's live runtime catalog (Task 11b) describes ONE instance's CLI. It must
// substitute that single instance's rows without suppressing every OTHER enabled instance —
// the model picker is how the user switches provider, so one instance's catalog silently
// hiding the rest was the regression this override shape fixes.
describe('allVisibleModels rowOverrides', () => {
  it('substitutes rows for the overridden instance only — other enabled instances are untouched', () => {
    const models = allVisibleModels(multi(), {
      'claude-default': [{ slug: 'claude-opus-5', name: 'Claude Opus 5' }]
    })
    const claude = models.filter((m) => m.instanceId === 'claude-default')
    expect(claude.map((m) => m.slug)).toEqual(['claude-opus-5'])
    // requirement 2: identity fields come from the per-instance map entry, not borrowed
    expect(claude[0]).toMatchObject({
      instanceId: 'claude-default',
      driverKind: 'claude-agent-sdk',
      providerLabel: 'Claude'
    })
    // the regression: copilot-1's own rows must still appear, unaffected
    const copilot = models.filter((m) => m.instanceId === 'copilot-1')
    expect(copilot.map((m) => m.slug)).toEqual(['auto'])
  })

  it('a catalog-only slug absent from the static list still gets correct per-instance identity', () => {
    const models = allVisibleModels(multi(), {
      'claude-default': [{ slug: 'claude-opus-5', name: 'Claude Opus 5' }]
    })
    expect(CATALOG_ORDER).not.toContain('claude-opus-5')
    const opus5 = models.find((m) => m.slug === 'claude-opus-5')
    expect(opus5).toMatchObject({
      instanceId: 'claude-default',
      driverKind: 'claude-agent-sdk',
      providerLabel: 'Claude'
    })
  })

  it('an empty row list for an instance is treated as "no override" — falls through to its normal rows', () => {
    const withEmpty = allVisibleModels(multi(), { 'claude-default': [] })
    const withoutOverride = allVisibleModels(multi())
    expect(withEmpty).toEqual(withoutOverride)
  })

  it('an instance absent from the map keeps its existing visibility + ordering behaviour exactly', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'claude-default',
        providerInstances: {
          'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} },
          'copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
        },
        modelPreferences: {
          'claude-default': {
            hiddenModels: ['claude-opus-4-7'],
            favoriteModels: ['claude-haiku-4-5'],
            modelOrder: []
          }
        }
      }
    })
    // Override only copilot-1; claude-default has no map entry at all.
    const withOverride = allVisibleModels(s, { 'copilot-1': [{ slug: 'auto', name: 'Auto' }] })
    const withoutOverride = allVisibleModels(s)
    const claudeWith = withOverride.filter((m) => m.instanceId === 'claude-default')
    const claudeWithout = withoutOverride.filter((m) => m.instanceId === 'claude-default')
    expect(claudeWith).toEqual(claudeWithout)
    // sanity: prefs actually took effect (favorite first, hidden excluded)
    expect(claudeWith.map((m) => m.slug)).not.toContain('claude-opus-4-7')
    expect(claudeWith[0].slug).toBe('claude-haiku-4-5')
  })

  it('is optional and additive — omitting the second argument behaves identically to before', () => {
    expect(allVisibleModels(multi())).toEqual(allVisibleModels(multi(), undefined))
  })
})

describe('defaultModelRef', () => {
  it('is the default instance’s top model, instance-qualified', () => {
    expect(defaultModelRef(multi())).toEqual({
      instanceId: 'claude-default',
      slug: 'claude-fable-5'
    })
  })

  it('follows the default instance when it changes', () => {
    expect(defaultModelRef(multi({ activeInstanceId: 'copilot-1' }))).toEqual({
      instanceId: 'copilot-1',
      slug: 'auto'
    })
  })

  it('is undefined when no provider is enabled', () => {
    expect(defaultModelRef(multi({ claudeEnabled: false, copilotEnabled: false }))).toBeUndefined()
  })
})

describe('capabilitiesFor', () => {
  it('reports the named instance’s capabilities, not the default instance’s', () => {
    const s = multi()
    expect(capabilitiesFor(s, 'claude-default').editableApprovals).toBe(true)
    expect(capabilitiesFor(s, 'copilot-1').editableApprovals).toBe(false)
    expect(capabilitiesFor(s, 'copilot-1').costReporting).toBe(false)
  })

  it('falls back conservatively on an unknown instance or a null payload', () => {
    // Withholding an edit affordance costs a convenience; offering one the driver drops
    // is a false "your edit applied" signal.
    expect(capabilitiesFor(multi(), 'nope').editableApprovals).toBe(false)
    expect(capabilitiesFor(null, 'claude-default').editableApprovals).toBe(false)
    expect(capabilitiesFor(multi(), null).editableApprovals).toBe(false)
  })
})

describe('activeInstanceConfig with multiple providers', () => {
  it('follows the fallback when the named default is disabled', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'claude-default',
        providerInstances: {
          'claude-default': { driver: 'claude-agent-sdk', enabled: false, config: {} },
          'copilot-1': {
            driver: 'github-copilot',
            enabled: true,
            config: { cliPath: 'C:/copilot.exe' }
          }
        }
      }
    })
    expect(activeInstanceConfig(s).cliPath).toBe('C:/copilot.exe')
    expect(activeDriver(s)?.kind).toBe('github-copilot')
  })
})

describe('codex driver', () => {
  it('registers the codex driver with headless capabilities and no cost reporting', () => {
    const d = DRIVERS['codex']
    expect(d).toBeDefined()
    expect(d.capabilities.costReporting).toBe(false)
    expect(d.capabilities.headlessOneShot).toBe(true)
    expect(d.capabilities.editableApprovals).toBe(false)
    expect(d.models.map((m) => m.slug)).toContain('gpt-5.4')
  })

  it('has label/shortLabel and the gpt-5.4 default plus codex catalog', () => {
    const d = getDriver('codex')!
    expect(d.label).toBe('OpenAI Codex')
    expect(d.shortLabel).toBe('Codex')
    expect(d.models.map((m) => m.slug)).toEqual(['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'])
  })

  it('exposes ordered form annotations for cliPath and codexHome', () => {
    const d = getDriver('codex')!
    expect(d.formAnnotations.cliPath).toBeTruthy()
    expect(d.formAnnotations.codexHome).toBeTruthy()
    const orders = Object.values(d.formAnnotations).map((a) => a.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('config schema round-trips the per-instance codexHome setting alongside model/cliPath', () => {
    const d = getDriver('codex')!
    const parsed = d.configSchema.safeParse({
      model: 'gpt-5.4',
      cliPath: '/usr/local/bin/codex',
      codexHome: '~/.codex-work'
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toMatchObject({
      model: 'gpt-5.4',
      cliPath: '/usr/local/bin/codex',
      codexHome: '~/.codex-work'
    })
  })

  it('codex capabilities: all four permission modes, plan mode, no editable approvals', () => {
    const d = getDriver('codex')!
    expect(d.capabilities.permissionModes).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions'
    ])
    expect(d.capabilities.planMode).toBe(true)
  })
})
