import { describe, it, expect } from 'vitest'
import { DRIVERS, getDriverByKind, resolveDriver, getActiveDriver } from '../driverRegistry'
import { settingsSchema, type AgentSettings } from '../../../../shared/settings'

function agentSettings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return settingsSchema.parse({ agent: overrides }).agent
}

describe('driverRegistry', () => {
  it('registers both the Claude and Copilot drivers (Task 9A)', () => {
    expect(Object.keys(DRIVERS).sort()).toEqual(['claude-agent-sdk', 'github-copilot'])
  })

  it('getDriverByKind resolves registered kinds and falls back to Claude for the rest', () => {
    expect(getDriverByKind('github-copilot').kind).toBe('github-copilot')
    expect(getDriverByKind('claude-agent-sdk').kind).toBe('claude-agent-sdk')
    expect(getDriverByKind('zzz-future-driver').kind).toBe('claude-agent-sdk')
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

    it('the now-registered github-copilot slug resolves to the Copilot driver, no unknownSlug', () => {
      const s = agentSettings({
        activeInstanceId: 'copilot-default',
        providerInstances: {
          'copilot-default': { driver: 'github-copilot', enabled: true, config: {} }
        }
      })
      const r = resolveDriver(s)
      expect(r.driver.kind).toBe('github-copilot')
      expect(r.unknownSlug).toBeUndefined()
    })

    it('a genuinely unregistered driver slug falls back to Claude but flags unknownSlug', () => {
      const s = agentSettings({
        activeInstanceId: 'future-default',
        providerInstances: {
          'future-default': { driver: 'zzz-future-driver', enabled: true, config: {} }
        }
      })
      const r = resolveDriver(s)
      expect(r.driver.kind).toBe('claude-agent-sdk')
      expect(r.unknownSlug).toBe('zzz-future-driver')
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

    it('falls back to Claude for an unregistered slug (collapses the unknownSlug distinction)', () => {
      const s = agentSettings({
        activeInstanceId: 'future-default',
        providerInstances: {
          'future-default': { driver: 'zzz-future-driver', enabled: true, config: {} }
        }
      })
      expect(getActiveDriver(s).kind).toBe('claude-agent-sdk')
    })
  })
})
