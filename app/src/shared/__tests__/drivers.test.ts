import { describe, it, expect } from 'vitest'
import {
  DRIVERS,
  getDriver,
  driverConfig,
  activeInstanceConfig,
  type ClaudeDriverConfig
} from '../drivers'
import { settingsSchema } from '../settings'

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
})
