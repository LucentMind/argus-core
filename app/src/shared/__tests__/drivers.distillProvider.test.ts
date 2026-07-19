import { describe, it, expect } from 'vitest'
import { settingsSchema, type AppSettings } from '../settings'
import { resolveDistillProvider } from '../drivers'

/** Settings with a Copilot instance active and a Claude instance also enabled — the exact
 *  shape that produced the `model (auto)` distill failure on 2026-07-19. */
function copilotActive(overrides: Record<string, unknown> = {}): AppSettings {
  return settingsSchema.parse({
    agent: {
      activeInstanceId: 'github-copilot-1',
      providerInstances: {
        'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} },
        'claude-agent-sdk-1': { driver: 'claude-agent-sdk', enabled: true, config: {} }
      },
      ...overrides
    }
  })
}

describe('resolveDistillProvider', () => {
  it('REGRESSION: ignores the active Copilot instance and picks the enabled Claude one', () => {
    const r = resolveDistillProvider(copilotActive())
    expect(r).toMatchObject({ ok: true, instanceId: 'claude-agent-sdk-1' })
    if (!r.ok) throw new Error('unreachable')
    expect(r.model).not.toBe('auto')
    expect(r.model?.startsWith('claude-')).toBe(true)
  })

  it('fails with a specific reason when no enabled Claude instance exists', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'github-copilot-1',
        providerInstances: {
          'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
        }
      }
    })
    expect(resolveDistillProvider(s)).toEqual({
      ok: false,
      reason: 'no provider configured for distillation'
    })
  })

  it('honors an explicit distillProvider, including its model', () => {
    const s = copilotActive({
      distillProvider: { instanceId: 'claude-agent-sdk-1', model: 'claude-haiku-4-5' }
    })
    expect(resolveDistillProvider(s)).toMatchObject({
      ok: true,
      instanceId: 'claude-agent-sdk-1',
      model: 'claude-haiku-4-5'
    })
  })

  it('rejects an explicit instance that is disabled', () => {
    const s = copilotActive({
      providerInstances: {
        'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} },
        'claude-agent-sdk-1': { driver: 'claude-agent-sdk', enabled: false, config: {} }
      },
      distillProvider: { instanceId: 'claude-agent-sdk-1' }
    })
    expect(resolveDistillProvider(s)).toEqual({
      ok: false,
      reason: 'distillation provider "claude-agent-sdk-1" is unknown or disabled'
    })
  })

  it('rejects an explicit instance whose driver cannot run headless', () => {
    const s = copilotActive({ distillProvider: { instanceId: 'github-copilot-1' } })
    expect(resolveDistillProvider(s)).toEqual({
      ok: false,
      reason: 'provider "github-copilot-1" (github-copilot) cannot run headless distillation'
    })
  })

  it('prefers the instance config model over the catalog default', () => {
    const s = copilotActive({
      providerInstances: {
        'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} },
        'claude-agent-sdk-1': {
          driver: 'claude-agent-sdk',
          enabled: true,
          config: { model: 'claude-opus-4-8', cliPath: '/custom/claude' }
        }
      }
    })
    expect(resolveDistillProvider(s)).toMatchObject({
      ok: true,
      model: 'claude-opus-4-8',
      cliPath: '/custom/claude'
    })
  })
})
