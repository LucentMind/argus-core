import { describe, it, expect } from 'vitest'
import { settingsSchema, type AppSettings } from '../settings'
import { resolveDistillProvider, resolveDistillAgentProvider } from '../drivers'

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
    const s = copilotActive({
      providerInstances: {
        'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} },
        'future-1': { driver: 'future-driver', enabled: true, config: {} }
      },
      distillProvider: { instanceId: 'future-1' }
    })
    expect(resolveDistillProvider(s)).toEqual({
      ok: false,
      reason: 'provider "future-1" (future-driver) cannot run headless distillation'
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

describe('resolveDistillAgentProvider', () => {
  it('resolves the enabled Claude instance, ignoring an active Copilot instance', () => {
    const r = resolveDistillAgentProvider(copilotActive())
    expect(r).toMatchObject({ ok: true, instanceId: 'claude-agent-sdk-1' })
    if (!r.ok) throw new Error('unreachable')
    expect(r.model?.startsWith('claude-')).toBe(true)
  })

  it('fails with a specific reason when no enabled instance supports headlessAgent', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'github-copilot-1',
        providerInstances: {
          'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
        }
      }
    })
    expect(resolveDistillAgentProvider(s)).toEqual({
      ok: false,
      reason: 'no provider configured for agent-based distillation'
    })
  })

  it('rejects an explicit instance whose driver lacks headlessAgent, even though it supports headlessOneShot', () => {
    // github-copilot: headlessOneShot true, headlessAgent false — proves the resolver checks
    // the AGENT capability specifically, not just "can this driver run headless at all".
    const s = copilotActive({ distillProvider: { instanceId: 'github-copilot-1' } })
    expect(resolveDistillAgentProvider(s)).toEqual({
      ok: false,
      reason: 'provider "github-copilot-1" (github-copilot) cannot run agent-based distillation'
    })
  })

  it('honors an explicit distillProvider, including its model', () => {
    const s = copilotActive({
      distillProvider: { instanceId: 'claude-agent-sdk-1', model: 'claude-haiku-4-5' }
    })
    expect(resolveDistillAgentProvider(s)).toMatchObject({
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
    expect(resolveDistillAgentProvider(s)).toEqual({
      ok: false,
      reason: 'distillation provider "claude-agent-sdk-1" is unknown or disabled'
    })
  })
})

// ── the fresh-install default: Sonnet 5, decoupled from chat favourites ────────────────────
//
// Before this, "Automatic" resolved to the top ordered visible row of the instance — which is
// row 0 of the static list on a pristine install and the FIRST FAVOURITE the moment the user
// stars anything. So starring Opus 4.8 for chat silently moved distillation, RCA reports,
// reference sync and the editor's draft/improve onto Opus 4.8. Spec
// 2026-09-07-fresh-install-model-defaults: background jobs get their own built-in default and
// only an explicit choice (the Distillation picker, or a hand-edited config.model) moves it.
describe('distillation default model (spec 2026-09-07)', () => {
  const claudeOnly = (over: Record<string, unknown> = {}): AppSettings =>
    settingsSchema.parse({
      agent: {
        activeInstanceId: 'claude-agent-sdk-1',
        providerInstances: {
          'claude-agent-sdk-1': { driver: 'claude-agent-sdk', enabled: true, config: {} }
        },
        ...over
      }
    })

  it('resolves to Sonnet 5 on a pristine install, for both the one-shot and the agent resolver', () => {
    expect(resolveDistillProvider(claudeOnly())).toMatchObject({
      ok: true,
      instanceId: 'claude-agent-sdk-1',
      model: 'claude-sonnet-5'
    })
    expect(resolveDistillAgentProvider(claudeOnly())).toMatchObject({
      ok: true,
      model: 'claude-sonnet-5'
    })
  })

  it('does not follow chat favourites — the decoupling', () => {
    const s = claudeOnly({
      modelPreferences: {
        'claude-agent-sdk-1': {
          hiddenModels: [],
          favoriteModels: ['claude-opus-4-8', 'claude-opus-5'],
          modelOrder: ['claude-fable-5-1']
        }
      }
    })
    expect(resolveDistillProvider(s)).toMatchObject({ ok: true, model: 'claude-sonnet-5' })
  })

  it('an explicit Distillation-section choice wins over the built-in default', () => {
    const s = claudeOnly({
      distillProvider: { instanceId: 'claude-agent-sdk-1', model: 'claude-fable-5-1' }
    })
    expect(resolveDistillProvider(s)).toMatchObject({ ok: true, model: 'claude-fable-5-1' })
  })

  it('a hand-edited config.model wins over the built-in default', () => {
    const s = claudeOnly({
      providerInstances: {
        'claude-agent-sdk-1': {
          driver: 'claude-agent-sdk',
          enabled: true,
          config: { model: 'claude-opus-4-7' }
        }
      }
    })
    expect(resolveDistillProvider(s)).toMatchObject({ ok: true, model: 'claude-opus-4-7' })
  })

  // Hiding is the one preference that must still be honoured: never run a model the user
  // removed from their list. Fall back to the top ordered VISIBLE row, exactly as before.
  it('falls back to the top visible row when the user hid Sonnet 5', () => {
    const s = claudeOnly({
      modelPreferences: {
        'claude-agent-sdk-1': {
          hiddenModels: ['claude-sonnet-5'],
          favoriteModels: ['claude-opus-4-8'],
          modelOrder: []
        }
      }
    })
    const r = resolveDistillProvider(s)
    expect(r).toMatchObject({ ok: true, model: 'claude-opus-4-8' })
    if (!r.ok) throw new Error('unreachable')
    expect(r.model).not.toBe('claude-sonnet-5')
  })

  // The constant is keyed by driver kind and only Claude has one. Copilot's catalog is the
  // single `auto` router; a Claude slug there would be a wire error, not a default.
  it('never applies the Claude default to an explicitly chosen non-Claude instance', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'claude-agent-sdk-1',
        providerInstances: {
          'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} },
          'claude-agent-sdk-1': { driver: 'claude-agent-sdk', enabled: true, config: {} }
        },
        distillProvider: { instanceId: 'github-copilot-1' }
      }
    })
    expect(resolveDistillProvider(s)).toMatchObject({
      ok: true,
      instanceId: 'github-copilot-1',
      model: 'auto'
    })
  })
})
