import { describe, it, expect, vi } from 'vitest'
import { ProviderStatusService } from '../providerStatus'
import { createNpmVersionLookup } from '../npmVersion'
import type { AgentSettings } from '../../../../shared/settings'
import type { AgentDriver, ProbeAuthResult } from '../driver'
import { CLAUDE_TOOL_TAXONOMY } from '../risk'
import { PERMISSION_MODES } from '../../../../shared/settings'

function agentSettings(over?: Partial<AgentSettings>): AgentSettings {
  return {
    activeInstanceId: 'claude-default',
    maxSessions: 3,
    probeTimeoutMs: 10000,
    defaultPermissionMode: 'default',
    personaAppend: '',
    providerInstances: {
      'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} },
      'copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
    },
    modelPreferences: {},
    ...over
  } as AgentSettings
}

function fakeDriver(kind: string, probe: () => Promise<ProbeAuthResult>): AgentDriver {
  return {
    kind: kind as never,
    toolTaxonomy: CLAUDE_TOOL_TAXONOMY,
    authFixHint: `fix ${kind}`,
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: true,
      costReporting: true,
      headlessOneShot: false
    },
    createSession: () => ({}) as never,
    probeAuth: probe
  }
}

describe('ProviderStatusService', () => {
  it('probes every enabled instance and reports each independently', async () => {
    const svc = new ProviderStatusService({
      settings: agentSettings,
      driverFor: (id) =>
        id === 'claude-default'
          ? fakeDriver('claude-agent-sdk', async () => ({
              ok: true,
              detail: 'ready',
              email: 'x@y.z',
              version: '2.1.204'
            }))
          : fakeDriver('github-copilot', async () => ({ ok: false, detail: 'not authenticated' })),
      notify: () => {},
      now: () => new Date('2026-07-19T10:00:00Z')
    })
    await svc.refreshAll()
    const list = svc.list()
    expect(list.map((s) => [s.instanceId, s.state])).toEqual([
      ['claude-default', 'ready'],
      ['copilot-1', 'error']
    ])
    expect(list[0].email).toBe('x@y.z')
    expect(list[0].checkedAt).toBe('2026-07-19T10:00:00.000Z')
    // a failed provider carries ITS driver's remediation, not the other's
    expect(list[1].fixHint).toBe('fix github-copilot')
    expect(list[0].fixHint).toBeUndefined()
  })

  it('lists a never-probed instance as checking rather than omitting it', () => {
    const svc = new ProviderStatusService({
      settings: agentSettings,
      driverFor: () => fakeDriver('claude-agent-sdk', async () => ({ ok: true, detail: 'x' })),
      notify: () => {}
    })
    expect(svc.list().map((s) => s.state)).toEqual(['checking', 'checking'])
    expect(svc.list()[0].checkedAt).toBeNull()
  })

  it('turns a throwing probe into an error status instead of rejecting', async () => {
    const svc = new ProviderStatusService({
      settings: () =>
        agentSettings({
          providerInstances: { a: { driver: 'claude-agent-sdk', enabled: true, config: {} } }
        } as never),
      driverFor: () =>
        fakeDriver('claude-agent-sdk', async () => {
          throw new Error('probe exploded')
        }),
      notify: () => {}
    })
    await svc.refreshAll()
    expect(svc.list()[0]).toMatchObject({ state: 'error', detail: 'probe exploded' })
  })

  it('shares one in-flight probe between concurrent refreshes of the same instance', async () => {
    let calls = 0
    const svc = new ProviderStatusService({
      settings: agentSettings,
      driverFor: () =>
        fakeDriver('claude-agent-sdk', async () => {
          calls++
          await new Promise((r) => setTimeout(r, 5))
          return { ok: true, detail: 'ready' }
        }),
      notify: () => {}
    })
    await Promise.all([svc.refreshOne('claude-default'), svc.refreshOne('claude-default')])
    expect(calls).toBe(1)
  })

  it('flags an available update only when the published version differs', async () => {
    const make = (latest: string | null): ProviderStatusService =>
      new ProviderStatusService({
        settings: () =>
          agentSettings({
            providerInstances: { a: { driver: 'claude-agent-sdk', enabled: true, config: {} } }
          } as never),
        driverFor: () =>
          fakeDriver('claude-agent-sdk', async () => ({
            ok: true,
            detail: 'ready',
            version: '2.1.200'
          })),
        notify: () => {},
        latestVersion: async () => latest
      })

    const behind = make('2.1.204')
    await behind.refreshAll()
    expect(behind.list()[0].latestVersion).toBe('2.1.204')

    const current = make('2.1.200')
    await current.refreshAll()
    expect(current.list()[0].latestVersion).toBeUndefined()

    // registry unreachable → no advisory, and emphatically not an error state
    const offline = make(null)
    await offline.refreshAll()
    expect(offline.list()[0].latestVersion).toBeUndefined()
    expect(offline.list()[0].state).toBe('ready')
  })

  it('drops cached status for an instance that was switched off', async () => {
    let settings = agentSettings()
    const svc = new ProviderStatusService({
      settings: () => settings,
      driverFor: () => fakeDriver('claude-agent-sdk', async () => ({ ok: true, detail: 'ready' })),
      notify: () => {}
    })
    await svc.refreshAll()
    expect(svc.list()).toHaveLength(2)
    settings = agentSettings({
      providerInstances: {
        'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} },
        'copilot-1': { driver: 'github-copilot', enabled: false, config: {} }
      }
    } as never)
    svc.onSettingsChanged()
    expect(svc.list().map((s) => s.instanceId)).toEqual(['claude-default'])
  })
})

describe('createNpmVersionLookup', () => {
  it('returns the published version and caches it', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.2.3' }) }))
    const lookup = createNpmVersionLookup({ fetch: fetchMock as never, now: () => 0 })
    expect(await lookup('@github/copilot')).toBe('1.2.3')
    expect(await lookup('@github/copilot')).toBe('1.2.3')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('collapses every failure mode to null — a version check is not a provider problem', async () => {
    const boom = createNpmVersionLookup({
      fetch: (async () => {
        throw new Error('offline')
      }) as never,
      now: () => 0
    })
    expect(await boom('x')).toBeNull()

    const notFound = createNpmVersionLookup({
      fetch: (async () => ({ ok: false, json: async () => ({}) })) as never,
      now: () => 0
    })
    expect(await notFound('x')).toBeNull()

    const malformed = createNpmVersionLookup({
      fetch: (async () => ({ ok: true, json: async () => ({ version: 42 }) })) as never,
      now: () => 0
    })
    expect(await malformed('x')).toBeNull()
  })
})
