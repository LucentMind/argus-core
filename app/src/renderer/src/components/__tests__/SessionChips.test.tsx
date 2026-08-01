// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionChips } from '../SessionChips'
import { agentStore } from '../../lib/agentStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings } from '../../../../shared/settings'
import type { AuthStatus } from '../../../../shared/types'

function auth(overrides?: Partial<AuthStatus>): AuthStatus {
  return { ok: true, verified: true, detail: 'claude ready', ...overrides }
}

beforeEach(() => {
  settingsStore.reset()
  window.argus = {
    agent: {
      authStatus: vi.fn(async () => auth()),
      preflight: vi.fn(async () => ({ ok: true, checks: [] })),
      onAuthChanged: vi.fn(() => () => {})
    },
    settings: {
      get: vi.fn(async () => ({
        settings: defaultSettings(),
        resolvedTools: [],
        dataRoot: { path: 'C:\\x', fromEnv: false },
        loadError: null
      })),
      patch: vi.fn(),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

describe('SessionChips readiness', () => {
  it('collapses a healthy agent and toolchain to one ready chip', async () => {
    render(<SessionChips slug="case-a" sessionId={1} />)
    expect(await screen.findByText('ready')).toBeTruthy()
    expect(screen.queryByText('tools ✓')).toBeNull()
  })

  it('names the agent when auth is the thing that failed', async () => {
    window.argus.agent.authStatus = vi.fn(async () => auth({ ok: false, detail: 'signed out' }))
    render(<SessionChips slug="case-a" sessionId={1} />)
    expect(await screen.findByText('agent ✗')).toBeTruthy()
  })

  it('names the toolchain when preflight is the thing that failed', async () => {
    window.argus.agent.preflight = vi.fn(async () => ({
      ok: false,
      checks: [{ name: 'gh', ok: false, detail: 'not on PATH' }]
    }))
    render(<SessionChips slug="case-a" sessionId={1} />)
    expect(await screen.findByText('tools ✗')).toBeTruthy()
  })

  it('marks an unverified but ok sign-in as provisional', async () => {
    window.argus.agent.authStatus = vi.fn(async () => auth({ verified: false }))
    render(<SessionChips slug="case-a" sessionId={1} />)
    expect(await screen.findByText('ready ~')).toBeTruthy()
  })
})

describe('SessionChips cost', () => {
  it('renders the running token total', async () => {
    render(<SessionChips slug="case-a" sessionId={1} />)
    await screen.findByText('ready')
    // `turn.completed` is the only event that accumulates cost (agentStore.ts:195) —
    // there is no `cost` event.
    act(() => {
      agentStore.apply({
        eventId: 'e',
        caseId: 1,
        caseSlug: 'case-a',
        sessionId: 1,
        turnId: 1,
        ts: '2026-07-31T14:01:00.000Z',
        type: 'turn.completed',
        payload: { inputTokens: 140000, outputTokens: 797, costUsd: 27.04 }
      } as never)
    })
    // toLocaleString()'s thousands separator is host-locale-dependent (this machine's
    // Node default resolves to de-DE, which renders "140.797" not "140,797") — match
    // either grouping character rather than assuming en-US.
    expect(screen.getByText(/140[.,]797 tok/)).toBeTruthy()
    expect(screen.getByText(/\$27\.04/)).toBeTruthy()
  })

  it('says n/a rather than $0.00 for a provider that reports no cost', async () => {
    // `capabilitiesFor` only returns costReporting:false for an instance that actually
    // resolves to the github-copilot driver. An unresolved instance id (e.g. a bare
    // "copilot-1" string that names nothing in providerInstances) falls back to
    // DEFAULT_CAPABILITIES, whose costReporting is true (see shared/drivers.ts
    // capabilitiesFor + DEFAULT_CAPABILITIES) — that would make this test pass for the
    // wrong reason. Build settings with a real, enabled github-copilot instance instead.
    const s = defaultSettings()
    s.agent.providerInstances['copilot-1'] = {
      driver: 'github-copilot',
      enabled: true,
      config: {}
    }
    window.argus.settings.get = vi.fn(async () => ({
      settings: s,
      resolvedTools: [],
      dataRoot: { path: 'C:\\x', fromEnv: false },
      loadError: null
    }))
    render(<SessionChips slug="case-a" sessionId={1} instanceId="copilot-1" />)
    expect(await screen.findByText(/n\/a/)).toBeTruthy()
  })
})
