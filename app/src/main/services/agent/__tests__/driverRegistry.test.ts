import { describe, it, expect } from 'vitest'
import { DRIVERS, getDriverByKind, resolveDriver, getActiveDriver } from '../driverRegistry'
import { settingsSchema, type AgentSettings } from '../../../../shared/settings'

function agentSettings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return settingsSchema.parse({ agent: overrides }).agent
}

describe('driverRegistry', () => {
  it('DRIVERS stays Claude-only until Task 9A registers github-copilot', () => {
    expect(Object.keys(DRIVERS)).toEqual(['claude-agent-sdk'])
  })

  it('getDriverByKind falls back to Claude for an unregistered kind', () => {
    expect(getDriverByKind('github-copilot').kind).toBe('claude-agent-sdk')
    expect(getDriverByKind('claude-agent-sdk').kind).toBe('claude-agent-sdk')
  })

  describe('resolveDriver', () => {
    it('a known active driver resolves directly, with no unknownSlug', () => {
      const s = agentSettings({
        activeInstanceId: 'claude-default',
        providerInstances: {
          'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} }
        }
      })
      const r = resolveDriver(s)
      expect(r.driver.kind).toBe('claude-agent-sdk')
      expect(r.unknownSlug).toBeUndefined()
    })

    it('a missing active instance falls back to Claude silently (no unknownSlug)', () => {
      const s = agentSettings({ activeInstanceId: 'does-not-exist', providerInstances: {} })
      const r = resolveDriver(s)
      expect(r.driver.kind).toBe('claude-agent-sdk')
      expect(r.unknownSlug).toBeUndefined()
    })

    it('a disabled active instance falls back to Claude silently (no unknownSlug)', () => {
      const s = agentSettings({
        activeInstanceId: 'claude-default',
        providerInstances: {
          'claude-default': { driver: 'claude-agent-sdk', enabled: false, config: {} }
        }
      })
      const r = resolveDriver(s)
      expect(r.driver.kind).toBe('claude-agent-sdk')
      expect(r.unknownSlug).toBeUndefined()
    })

    it('an unknown driver slug (e.g. github-copilot, before Task 9A registers it) falls back to Claude but flags unknownSlug', () => {
      const s = agentSettings({
        activeInstanceId: 'copilot-default',
        providerInstances: {
          'copilot-default': { driver: 'github-copilot', enabled: true, config: {} }
        }
      })
      const r = resolveDriver(s)
      expect(r.driver.kind).toBe('claude-agent-sdk')
      expect(r.unknownSlug).toBe('github-copilot')
    })
  })

  describe('getActiveDriver', () => {
    it('mirrors resolveDriver().driver for a known instance', () => {
      const s = agentSettings({
        activeInstanceId: 'claude-default',
        providerInstances: {
          'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} }
        }
      })
      expect(getActiveDriver(s).kind).toBe('claude-agent-sdk')
    })

    it('falls back to Claude for an unknown slug too (collapses the unknownSlug distinction)', () => {
      const s = agentSettings({
        activeInstanceId: 'copilot-default',
        providerInstances: {
          'copilot-default': { driver: 'github-copilot', enabled: true, config: {} }
        }
      })
      expect(getActiveDriver(s).kind).toBe('claude-agent-sdk')
    })
  })
})
