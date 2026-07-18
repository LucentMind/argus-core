// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProviderStep } from '../steps'
import { settingsStore } from '../../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../../shared/settings'
import type { AuthStatus } from '../../../../../shared/types'

// The step names the ACTIVE provider, so it reads settings as well as auth status.
function settingsPayload(): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

function mockSettings(): Record<string, unknown> {
  return {
    get: vi.fn(async () => settingsPayload()),
    patch: vi.fn(async () => settingsPayload()),
    onChanged: vi.fn(() => () => {})
  }
}

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
  settingsStore.reset()
  window.argus = {
    settings: mockSettings(),
    agent: {
      authStatus: vi.fn(async (): Promise<AuthStatus> => mockAuth())
    }
  } as never
})

describe('ProviderStep', () => {
  it('shows logged-in identity and opens the gate', async () => {
    const setGate = vi.fn()
    render(<ProviderStep setGate={setGate} />)
    await waitFor(() => expect(screen.getByText(/logged in as x@y\.z/i)).toBeTruthy())
    expect(screen.queryByText(/claude is ready/i)).toBeNull()
    expect(setGate).toHaveBeenCalledWith(true)
  })

  it('shows guidance and keeps the gate closed when not logged in', async () => {
    window.argus = {
      settings: mockSettings(),
      agent: {
        authStatus: vi.fn(async (): Promise<AuthStatus> => ({
          ok: false,
          verified: false,
          detail: 'not logged in'
        }))
      }
    } as never
    const setGate = vi.fn()
    render(<ProviderStep setGate={setGate} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /re-check/i })).toBeTruthy())
    expect(setGate).toHaveBeenCalledWith(false)
  })

  it('renders the probe’s own fix hint rather than Claude-specific advice', async () => {
    settingsStore.reset()
    window.argus = {
      settings: mockSettings(),
      agent: {
        authStatus: vi.fn(async (): Promise<AuthStatus> => ({
          ok: false,
          verified: false,
          detail: 'copilot not authenticated',
          fixHint: 'Sign in to GitHub with `gh auth login`.'
        }))
      }
    } as never
    render(<ProviderStep setGate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/gh auth login/i)).toBeTruthy())
    expect(screen.queryByText(/claude login/i)).toBeNull()
  })
})
