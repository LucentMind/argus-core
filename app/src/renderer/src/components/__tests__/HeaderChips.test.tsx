// @vitest-environment jsdom
import { render, screen, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HeaderChips } from '../HeaderChips'
import { agentStore } from '../../lib/agentStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings } from '../../../../shared/settings'
import type { AuthStatus } from '../../../../shared/types'
import type { AgentEvent } from '../../../../shared/agent-events'

function auth(overrides?: Partial<AuthStatus>): AuthStatus {
  return { ok: true, verified: false, detail: 'claude ready', ...overrides }
}

function settingsGet(settings = defaultSettings()): () => Promise<unknown> {
  return vi.fn(async () => ({
    settings,
    resolvedTools: [],
    dataRoot: { path: 'C:\\x', fromEnv: false },
    loadError: null
  }))
}

let onAuthChangedCb: (() => void) | null = null

beforeEach(() => {
  onAuthChangedCb = null
  settingsStore.reset()
  window.argus = {
    agent: {
      authStatus: vi.fn(async () => auth()),
      preflight: vi.fn(async () => ({ ok: true, checks: [] })),
      onAuthChanged: vi.fn((cb: () => void) => {
        onAuthChangedCb = cb
        return () => {
          onAuthChangedCb = null
        }
      })
    },
    settings: {
      get: settingsGet(),
      patch: vi.fn(),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

// The real, only way get() ever returns ok:false with this text (see AuthCache.get):
// a prior turn 401'd (onAuthFailure), and the probe — which runs with maxTurns:0 and
// never contacts the API — cannot override that verdict.
const AUTH_FAILURE_DETAIL =
  'Claude rejected the last message — sign in with /login, then send again'

describe('HeaderChips auth reactivity', () => {
  it('refetches and updates the chip when agent:auth-changed broadcasts', async () => {
    window.argus.agent.authStatus = vi.fn(async () =>
      auth({ ok: false, detail: AUTH_FAILURE_DETAIL })
    )
    render(<HeaderChips slug="case-a" sessionId={null} />)
    expect(await screen.findByText('claude ✗')).toBeTruthy()

    // simulate: a turn just verified — main broadcasts agent:auth-changed
    window.argus.agent.authStatus = vi.fn(async () => auth({ ok: true, verified: true }))
    await act(async () => onAuthChangedCb?.())

    expect(await screen.findByText('claude ✓')).toBeTruthy()
  })

  it('ignores a stale in-flight mount probe that resolves after a newer broadcast refresh', async () => {
    let resolveMountProbe!: (s: AuthStatus) => void
    const mountProbe = new Promise<AuthStatus>((resolve) => {
      resolveMountProbe = resolve
    })
    const authStatus = vi
      .fn<(force?: boolean) => Promise<AuthStatus>>()
      // 1st call: the mount-time probe — stays pending until we resolve it below.
      .mockImplementationOnce(() => mountProbe)
      // 2nd call: triggered by the auth-changed broadcast — resolves immediately, as it
      // does for real once onAuthFailure() has recorded turn evidence (no re-probe needed).
      .mockImplementationOnce(async () => auth({ ok: false, detail: AUTH_FAILURE_DETAIL }))
    window.argus.agent.authStatus = authStatus

    render(<HeaderChips slug="case-a" sessionId={null} />)
    expect(await screen.findByText('claude …')).toBeTruthy() // mount probe still pending

    // a turn 401s: main clears the cache and broadcasts before the mount probe settles
    await act(async () => onAuthChangedCb?.())
    expect(await screen.findByText('claude ✗')).toBeTruthy()

    // NOW the stale mount-time probe resolves with the old (stale) green status.
    // It must be ignored — the chip must stay on the newer, correct red state.
    await act(async () => {
      resolveMountProbe(auth({ ok: true, verified: false }))
      await mountProbe
    })

    expect(screen.getByText('claude ✗')).toBeTruthy()
    expect(screen.queryByText('claude ✓')).toBeNull()
    expect(screen.queryByText('claude ~')).toBeNull()
  })

  it('unsubscribes from agent:auth-changed on unmount', () => {
    const unsubscribe = vi.fn()
    window.argus.agent.onAuthChanged = vi.fn((cb: () => void) => {
      onAuthChangedCb = cb
      return unsubscribe
    })
    const { unmount } = render(<HeaderChips slug="case-a" sessionId={null} />)
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})

describe('HeaderChips cost display', () => {
  const base = {
    eventId: 'e',
    caseId: 1,
    caseSlug: 'NAV-COST',
    sessionId: 1,
    turnId: 1,
    ts: '2026-07-09T00:00:00Z'
  }
  const turnCompleted = (caseSlug: string, costUsd: number): AgentEvent =>
    ({
      ...base,
      caseSlug,
      type: 'turn.completed',
      payload: { status: 'success', inputTokens: 10, outputTokens: 5, costUsd, durationMs: 5 }
    }) as AgentEvent

  it('renders the $ amount when the active driver reports cost', async () => {
    agentStore.apply(turnCompleted('NAV-COST-A', 0.05))
    render(<HeaderChips slug="NAV-COST-A" sessionId={1} />)
    expect(await screen.findByText(/\$0\.05/)).toBeTruthy()
  })

  it('renders no cost suffix (not "n/a") when a reporting driver truly has zero accumulated cost', () => {
    render(<HeaderChips slug="NAV-COST-ZERO" sessionId={1} />)
    expect(screen.queryByText(/n\/a/)).toBeNull()
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  it('renders "n/a" instead of $0.00/blank when the active driver has costReporting: false', async () => {
    const s = defaultSettings()
    s.agent.providerInstances['claude-default'].driver = 'github-copilot'
    window.argus.settings.get = settingsGet(s)
    // even with a nonzero accumulator, copilot never reports real cost — n/a wins
    agentStore.apply(turnCompleted('NAV-COST-B', 0.05))
    render(<HeaderChips slug="NAV-COST-B" sessionId={1} />)
    await waitFor(() => expect(screen.getByText(/n\/a/)).toBeTruthy())
    expect(screen.queryByText(/\$0\.05/)).toBeNull()
  })
})
