// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HeaderChips } from '../HeaderChips'
import type { AuthStatus } from '../../../../shared/types'

function auth(overrides?: Partial<AuthStatus>): AuthStatus {
  return { ok: true, verified: false, detail: 'claude ready', ...overrides }
}

let onAuthChangedCb: (() => void) | null = null

beforeEach(() => {
  onAuthChangedCb = null
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
    }
  } as never
})

describe('HeaderChips auth reactivity', () => {
  it('refetches and updates the chip when agent:auth-changed broadcasts', async () => {
    window.argus.agent.authStatus = vi.fn(async () => auth({ ok: false, detail: 'not logged in' }))
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
      // 2nd call: triggered by the auth-changed broadcast — resolves immediately.
      .mockImplementationOnce(async () => auth({ ok: false, detail: 'auth failed mid-turn' }))
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
