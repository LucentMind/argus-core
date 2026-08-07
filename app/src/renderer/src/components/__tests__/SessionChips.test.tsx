// @vitest-environment jsdom
import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionChips } from '../SessionChips'
import { checkDetail } from '../../lib/preflightDetail'
import { agentStore } from '../../lib/agentStore'
import { settingsStore } from '../../lib/settingsStore'
import { uiStore } from '../../lib/uiStore'
import { defaultSettings } from '../../../../shared/settings'
import type { AuthStatus } from '../../../../shared/types'
import type { AgentEvent } from '../../../../shared/agent-events'

/** Fill in the envelope every AgentEvent carries so tests only state the payload. */
function emit(type: AgentEvent['type'], payload: unknown, slug = 'case-a'): void {
  act(() => {
    agentStore.apply({
      eventId: `e-${type}-${JSON.stringify(payload)}`,
      caseId: 1,
      caseSlug: slug,
      sessionId: 1,
      turnId: 1,
      ts: '2026-07-31T14:01:00.000Z',
      type,
      payload
    } as AgentEvent)
  })
}

/** The pill is the only control in the strip; opening it reveals the status popover. */
function openPopover(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Session status' }))
  return screen.getByTestId('session-status-popover')
}

function auth(overrides?: Partial<AuthStatus>): AuthStatus {
  return { ok: true, verified: true, detail: 'claude ready', ...overrides }
}

let onAuthChangedCb: (() => void) | null = null

// The real, only way get() ever returns ok:false with this text (see AuthCache.get):
// a prior turn 401'd (onAuthFailure), and the probe — which runs with maxTurns:0 and
// never contacts the API — cannot override that verdict.
const AUTH_FAILURE_DETAIL =
  'Claude rejected the last message — sign in with /login, then send again'

beforeEach(() => {
  onAuthChangedCb = null
  settingsStore.reset()
  // uiStore is a module singleton with no reset(); the dynamic-theme test flips it, and
  // leaving it on would silently change what every later test renders.
  uiStore.setDynamicTheme(false)
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

describe('SessionChips auth reactivity', () => {
  it('refetches and updates the chip when agent:auth-changed broadcasts', async () => {
    window.argus.agent.authStatus = vi.fn(async () =>
      auth({ ok: false, detail: AUTH_FAILURE_DETAIL })
    )
    render(<SessionChips slug="case-a" sessionId={1} />)
    expect(await screen.findByText('agent ✗')).toBeTruthy()

    // simulate: a turn just verified — main broadcasts agent:auth-changed
    window.argus.agent.authStatus = vi.fn(async () => auth({ ok: true, verified: true }))
    await act(async () => onAuthChangedCb?.())

    expect(await screen.findByText('ready')).toBeTruthy()
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

    render(<SessionChips slug="case-a" sessionId={1} />)
    // preflight resolves immediately, but auth is still pending — stays on "checking…"
    expect(await screen.findByText('checking…')).toBeTruthy()

    // a turn 401s: main clears the cache and broadcasts before the mount probe settles
    await act(async () => onAuthChangedCb?.())
    expect(await screen.findByText('agent ✗')).toBeTruthy()

    // NOW the stale mount-time probe resolves with the old (stale) ok status.
    // It must be ignored — the chip must stay on the newer, correct failed state.
    await act(async () => {
      resolveMountProbe(auth({ ok: true, verified: false }))
      await mountProbe
    })

    expect(screen.getByText('agent ✗')).toBeTruthy()
    expect(screen.queryByText('ready')).toBeNull()
    expect(screen.queryByText('ready ~')).toBeNull()
  })

  it('unsubscribes from agent:auth-changed on unmount', () => {
    const unsubscribe = vi.fn()
    window.argus.agent.onAuthChanged = vi.fn((cb: () => void) => {
      onAuthChangedCb = cb
      return unsubscribe
    })
    const { unmount } = render(<SessionChips slug="case-a" sessionId={1} />)
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})

describe('SessionChips cost', () => {
  it('keeps the token and cost readout inside the popover, never beside the pill', async () => {
    render(<SessionChips slug="case-a" sessionId={1} />)
    await screen.findByText('ready')
    // `turn.completed` is the only event that accumulates cost (agentStore.ts) — there is
    // no `cost` event.
    emit('turn.completed', { inputTokens: 140000, outputTokens: 797, costUsd: 27.04 })

    // The strip itself is the pill and nothing else: the running total used to sit next to it
    // and was the widest thing in the tab strip.
    const strip = screen.getByTestId('session-chips')
    expect(strip.textContent).toBe('ready')

    // toLocaleString()'s thousands separator is host-locale-dependent (this machine's
    // Node default resolves to de-DE, which renders "140.797" not "140,797") — match
    // either grouping character rather than assuming en-US.
    const popover = openPopover()
    expect(popover.textContent).toMatch(/140[.,]797/)
    expect(popover.textContent).toMatch(/\$27\.04/)
  })

  it('qualifies the estimate as an upper bound', async () => {
    // The SDK reports list price; on a subscription the marginal cost is lower or zero. An
    // unqualified "$27.04" reads as a bill.
    render(<SessionChips slug="case-a" sessionId={1} />)
    await screen.findByText('ready')
    expect(openPopover().textContent).toMatch(/Est\. cost \(actual cost is lower\)/)
  })

  it('renders no cost suffix (not "n/a") when a reporting driver truly has zero accumulated cost', async () => {
    // A fresh case/session with no turn.completed applied yet: the accumulator is still
    // at its zero initial value, and the default (claude) driver has costReporting: true.
    // That must render as a blank dash, not "n/a" (n/a is reserved for costReporting:
    // false) and not "$0.00" (no turn has actually completed yet).
    render(<SessionChips slug="NAV-COST-ZERO" sessionId={1} />)
    await screen.findByText('ready')
    const popover = openPopover()
    expect(popover.textContent).not.toMatch(/n\/a/)
    expect(popover.textContent).not.toMatch(/\$/)
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
    await screen.findByText('ready')
    expect(openPopover().textContent).toMatch(/n\/a/)
  })
})

describe('checkDetail', () => {
  it('drops a resolved absolute path on a passing check, on either platform', () => {
    expect(
      checkDetail({ name: 'dlt-parse', ok: true, detail: '/Users/j/Argus/packs/nav/bin/dlt-parse' })
    ).toBeNull()
    expect(
      checkDetail({
        name: 'dlt-parse',
        ok: true,
        detail: 'C:\\Users\\j\\packs\\bin\\dlt-parse.exe'
      })
    ).toBeNull()
    expect(checkDetail({ name: 'x', ok: true, detail: '\\\\server\\share\\x.exe' })).toBeNull()
  })

  it('drops a detail that only echoes the check name', () => {
    expect(checkDetail({ name: 'graphify', ok: true, detail: 'graphify' })).toBeNull()
  })

  it('keeps versions and sub-tool lists — the reason to open the popover at all', () => {
    expect(checkDetail({ name: 'navnative-trace', ok: true, detail: '0.3.0' })).toBe('0.3.0')
    // Contains slashes but is not a path: a bare-relative check must not be mistaken for one.
    expect(checkDetail({ name: 'esotrace', ok: true, detail: 'find/parse/extract esotrace' })).toBe(
      'find/parse/extract esotrace'
    )
  })

  it('keeps a failing check\u2019s detail even when it is a path — that is the fix hint', () => {
    expect(checkDetail({ name: 'gh', ok: false, detail: '/usr/local/bin/gh not found' })).toBe(
      '/usr/local/bin/gh not found'
    )
    expect(checkDetail({ name: 'gh', ok: false, detail: 'C:\\tools\\gh.exe' })).toBe(
      'C:\\tools\\gh.exe'
    )
  })
})

describe('SessionChips preflight detail', () => {
  it('lists a passing tool by name alone once its detail is just an install path', async () => {
    window.argus.agent.preflight = vi.fn(async () => ({
      ok: true,
      checks: [
        { name: 'dlt-parse', ok: true, detail: '/Users/j/Argus/packs/nav/bin/dlt-parse' },
        { name: 'navnative-trace', ok: true, detail: '0.3.0' }
      ]
    }))
    render(<SessionChips slug="case-a" sessionId={1} />)
    await screen.findByText('ready')
    const popover = openPopover()
    expect(popover.textContent).toContain('✓ dlt-parse')
    expect(popover.textContent).not.toContain('/Users/j/')
    expect(popover.textContent).toContain('✓ navnative-trace: 0.3.0')
  })
})

describe('SessionChips unconfirmed sign-in wording', () => {
  it('does not claim the sign-in is confirmed while reporting it unconfirmed', async () => {
    window.argus.agent.authStatus = vi.fn(async () =>
      auth({ verified: false, detail: 'claude ready (claude-sonnet-5)' })
    )
    render(<SessionChips slug="case-a" sessionId={1} />)
    await screen.findByText('ready ~')
    const popover = openPopover()
    expect(popover.textContent).toContain('ready (unconfirmed)')
    // The old copy read "— confirmed on your first message", i.e. an accomplished fact, sitting
    // directly under "(unconfirmed)". Whatever the wording, the detail must not assert that.
    expect(popover.textContent).not.toContain('confirmed on your first message')
    expect(popover.textContent).toMatch(/not confirmed yet/)
  })
})

describe('SessionChips context gauge', () => {
  const CONTEXT_SLUG = 'NAV-CTX'

  it('shows nothing until both the usage and the window size have arrived', async () => {
    render(<SessionChips slug={CONTEXT_SLUG} sessionId={1} />)
    await screen.findByText('ready')
    expect(screen.queryByTestId('context-gauge')).toBeNull()

    // usedTokens alone is not enough — a token count with no window is not a percentage.
    emit('context.usage', { usedTokens: 50_000, contextWindow: null }, CONTEXT_SLUG)
    expect(screen.queryByTestId('context-gauge')).toBeNull()

    emit('context.usage', { usedTokens: null, contextWindow: 200_000 }, CONTEXT_SLUG)
    expect(screen.getByTestId('context-gauge').style.width).toBe('25%')
  })

  it('tracks the level down after a compaction instead of accumulating', async () => {
    render(<SessionChips slug="NAV-CTX-COMPACT" sessionId={1} />)
    await screen.findByText('ready')
    emit('context.usage', { usedTokens: null, contextWindow: 200_000 }, 'NAV-CTX-COMPACT')
    emit('context.usage', { usedTokens: 180_000, contextWindow: null }, 'NAV-CTX-COMPACT')
    expect(screen.getByTestId('context-gauge').style.width).toBe('90%')

    // The CLI compacted: the live context really is smaller now. A cumulative counter would
    // have gone up.
    emit('context.usage', { usedTokens: 40_000, contextWindow: null }, 'NAV-CTX-COMPACT')
    expect(screen.getByTestId('context-gauge').style.width).toBe('20%')
  })

  it('clamps an over-full window rather than painting past the pill', async () => {
    render(<SessionChips slug="NAV-CTX-OVER" sessionId={1} />)
    await screen.findByText('ready')
    emit('context.usage', { usedTokens: 260_000, contextWindow: 200_000 }, 'NAV-CTX-OVER')
    expect(screen.getByTestId('context-gauge').style.width).toBe('100%')
  })

  it('paints the clean CSS edge in the classic theme', async () => {
    render(<SessionChips slug="NAV-CTX-THEME" sessionId={1} />)
    await screen.findByText('ready')
    emit('context.usage', { usedTokens: 100_000, contextWindow: 200_000 }, 'NAV-CTX-THEME')
    const el = screen.getByTestId('context-gauge')
    expect(el.dataset.mode).toBe('flat')
    expect(el.className).toContain('ctx-gauge')
    expect(el.style.width).toBe('50%')
  })

  it('keeps the clean edge under the dynamic theme when WebGL2 is unavailable', async () => {
    // jsdom has no WebGL2, which is exactly the fallback path a lost GPU process takes. The
    // wave rendering itself is covered in ContextGauge.test.tsx with an injected renderer;
    // what matters here is that a dynamic-theme user still gets a gauge.
    act(() => uiStore.setDynamicTheme(true))
    render(<SessionChips slug="NAV-CTX-THEME-DYN" sessionId={1} />)
    await screen.findByText('ready')
    emit('context.usage', { usedTokens: 100_000, contextWindow: 200_000 }, 'NAV-CTX-THEME-DYN')
    const el = screen.getByTestId('context-gauge')
    expect(el.dataset.mode).toBe('flat')
    expect(el.style.width).toBe('50%')
  })
})
