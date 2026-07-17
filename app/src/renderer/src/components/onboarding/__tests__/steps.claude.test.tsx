// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeStep } from '../steps'
import type { AuthStatus } from '../../../../../shared/types'

// Typed so a future omission (e.g. dropping `verified`) is a compile error, not silent
// drift papered over by the `as never` cast below on window.argus.
function mockAuth(overrides?: Partial<AuthStatus>): AuthStatus {
  return {
    ok: true,
    verified: true,
    detail: 'ok',
    email: 'x@y.z',
    subscription: 'Max',
    ...overrides
  }
}

beforeEach(() => {
  window.argus = {
    agent: {
      authStatus: vi.fn(async (): Promise<AuthStatus> => mockAuth())
    }
  } as never
})

describe('ClaudeStep', () => {
  it('shows logged-in identity and opens the gate', async () => {
    const setGate = vi.fn()
    render(<ClaudeStep setGate={setGate} />)
    await waitFor(() => expect(screen.getByText(/logged in as x@y\.z/i)).toBeTruthy())
    expect(screen.queryByText(/claude is ready/i)).toBeNull()
    expect(setGate).toHaveBeenCalledWith(true)
  })

  it('shows guidance and keeps the gate closed when not logged in', async () => {
    window.argus = {
      agent: {
        authStatus: vi.fn(async (): Promise<AuthStatus> => ({
          ok: false,
          verified: false,
          detail: 'not logged in'
        }))
      }
    } as never
    const setGate = vi.fn()
    render(<ClaudeStep setGate={setGate} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /re-check/i })).toBeTruthy())
    expect(setGate).toHaveBeenCalledWith(false)
  })
})
