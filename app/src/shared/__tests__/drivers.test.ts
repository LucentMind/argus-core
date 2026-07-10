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

  it('reserves sensitive: no driver field may set it until the keychain store exists', () => {
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
