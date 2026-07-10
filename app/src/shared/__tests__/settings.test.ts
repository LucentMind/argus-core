import { describe, it, expect } from 'vitest'
import {
  settingsSchema,
  defaultSettings,
  deepMerge,
  stripDefaults,
  SETTINGS_ATOMIC_PATHS
} from '../settings'

describe('settings schema', () => {
  it('parses {} to full defaults including the claude-default instance', () => {
    const s = settingsSchema.parse({})
    expect(s.general.timestampFormat).toBe('locale')
    expect(s.general.confirmCaseDelete).toBe(true)
    expect(s.agent.activeInstanceId).toBe('claude-default')
    expect(s.agent.maxSessions).toBe(3)
    expect(s.agent.probeTimeoutMs).toBe(10000)
    expect(s.agent.defaultPermissionMode).toBe('default')
    expect(s.agent.personaAppend).toBe('')
    expect(s.agent.providerInstances['claude-default']).toEqual({
      driver: 'claude-agent-sdk',
      enabled: true,
      config: {}
    })
    expect(s.tools).toEqual({ traceDir: '', parseBin: '' })
  })

  it('fills inner defaults for partial nested input', () => {
    const s = settingsSchema.parse({ agent: { maxSessions: 5 } })
    expect(s.agent.maxSessions).toBe(5)
    expect(s.agent.probeTimeoutMs).toBe(10000)
    expect(s.general.timestampFormat).toBe('locale')
  })

  it('passes through unknown keys at every level (forward compat)', () => {
    const s = settingsSchema.parse({
      future: { x: 1 },
      agent: { futureKey: 'y', maxSessions: 4 }
    }) as Record<string, unknown>
    expect((s.future as { x: number }).x).toBe(1)
    expect((s.agent as Record<string, unknown>).futureKey).toBe('y')
  })

  it('round-trips an unknown driver slug through providerInstances', () => {
    const s = settingsSchema.parse({
      agent: {
        providerInstances: {
          weird: { driver: 'future-driver', enabled: false, config: { secretShape: [1, 2] } }
        }
      }
    })
    expect(s.agent.providerInstances.weird.driver).toBe('future-driver')
    expect(s.agent.providerInstances.weird.config).toEqual({ secretShape: [1, 2] })
  })

  it('stripDefaults keeps only non-default leaves and unknown keys', () => {
    const s = settingsSchema.parse({ agent: { maxSessions: 5 }, future: { x: 1 } })
    const sparse = stripDefaults(s, defaultSettings()) as Record<string, unknown>
    expect(sparse).toEqual({ agent: { maxSessions: 5 }, future: { x: 1 } })
  })

  it('stripDefaults of pure defaults is {} and re-parses to defaults', () => {
    const sparse = stripDefaults(defaultSettings(), defaultSettings())
    expect(sparse).toEqual({})
    expect(settingsSchema.parse(sparse)).toEqual(defaultSettings())
  })

  it('deepMerge merges nested objects, replaces scalars, deletes on null', () => {
    const base = { a: { b: 1, c: 2 }, d: 'x', e: { f: 1 } }
    const out = deepMerge(base, { a: { b: 9 }, d: null, e: null }) as Record<string, unknown>
    expect(out).toEqual({ a: { b: 9, c: 2 } })
    expect(base.a.b).toBe(1) // no mutation
  })

  it('stripDefaults is key-order-insensitive', () => {
    const reordered = {
      agent: {
        providerInstances: {
          'claude-default': { config: {}, enabled: true, driver: 'claude-agent-sdk' }
        }
      }
    }
    const merged = settingsSchema.parse(reordered)
    expect(stripDefaults(merged, defaultSettings())).toEqual({})
  })

  it('stripDefaults handles deeply nested objects regardless of key order', () => {
    const result = stripDefaults({ a: { y: 2, x: 1 } }, { a: { x: 1, y: 2 } })
    expect(result).toEqual({})
  })

  it('stripDefaults drops array leaves equal to default regardless of inner key order', () => {
    expect(stripDefaults({ a: [{ y: 2, x: 1 }] }, { a: [{ x: 1, y: 2 }] })).toEqual({})
  })

  it('round-trips a config-level instance patch through strip + parse', () => {
    const patched = settingsSchema.parse(
      deepMerge(defaultSettings(), {
        agent: { providerInstances: { 'claude-default': { config: { model: 'claude-sonnet-5' } } } }
      })
    )
    const sparse = stripDefaults(patched, defaultSettings(), {
      atomicPaths: SETTINGS_ATOMIC_PATHS
    }) as Record<string, unknown>
    expect(settingsSchema.parse(sparse)).toEqual(patched)
    // the kept entry is verbatim — driver survives
    const agent = sparse.agent as Record<string, unknown>
    const providerInstances = agent.providerInstances as Record<string, Record<string, unknown>>
    expect(providerInstances['claude-default'].driver).toBe('claude-agent-sdk')
  })

  it('round-trips a displayName-level instance patch', () => {
    const patched = settingsSchema.parse(
      deepMerge(defaultSettings(), {
        agent: { providerInstances: { 'claude-default': { displayName: 'My Claude' } } }
      })
    )
    const sparse = stripDefaults(patched, defaultSettings(), { atomicPaths: SETTINGS_ATOMIC_PATHS })
    expect(settingsSchema.parse(sparse)).toEqual(patched)
  })

  it('still strips a pure-default instance map to {} with atomicPaths', () => {
    expect(
      stripDefaults(defaultSettings(), defaultSettings(), { atomicPaths: SETTINGS_ATOMIC_PATHS })
    ).toEqual({})
  })
})
