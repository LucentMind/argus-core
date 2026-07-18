// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProviderStep } from '../steps'
import type { ProviderStatus } from '../../../../../shared/types'

function status(over?: Partial<ProviderStatus>): ProviderStatus {
  return {
    instanceId: 'claude-default',
    driverKind: 'claude-agent-sdk',
    displayName: 'Claude',
    state: 'ready',
    detail: 'claude ready',
    checkedAt: '2026-07-19T10:00:00.000Z',
    ...over
  }
}

let statuses: ProviderStatus[]
beforeEach(() => {
  statuses = [status()]
  window.argus = {
    providers: {
      statuses: vi.fn(async () => statuses),
      refresh: vi.fn(async () => statuses),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

describe('ProviderStep', () => {
  it('lists every configured provider, not just the default one', async () => {
    statuses = [
      status({ email: 'x@y.z' }),
      status({
        instanceId: 'copilot-1',
        driverKind: 'github-copilot',
        displayName: 'Copilot',
        state: 'error',
        detail: 'not authenticated',
        fixHint: 'Sign in to GitHub with `gh auth login`.'
      })
    ]
    render(<ProviderStep setGate={vi.fn()} />)
    expect(await screen.findByText('Claude')).toBeTruthy()
    expect(screen.getByText('Copilot')).toBeTruthy()
  })

  it('opens the gate when at least one provider is ready, even if another failed', async () => {
    const setGate = vi.fn()
    statuses = [
      status(),
      status({ instanceId: 'copilot-1', displayName: 'Copilot', state: 'error', detail: 'nope' })
    ]
    render(<ProviderStep setGate={setGate} />)
    await waitFor(() => expect(setGate).toHaveBeenCalledWith(true))
    // a half-configured setup must not block finishing setup
    expect(await screen.findByText(/finish setup now/i)).toBeTruthy()
  })

  it('keeps the gate closed when no provider is ready', async () => {
    const setGate = vi.fn()
    statuses = [status({ state: 'error', detail: 'not logged in' })]
    render(<ProviderStep setGate={setGate} />)
    await waitFor(() => expect(setGate).toHaveBeenCalledWith(false))
  })

  it('shows each provider’s own remediation, never another vendor’s', async () => {
    statuses = [
      status({
        instanceId: 'copilot-1',
        displayName: 'Copilot',
        state: 'error',
        detail: 'not authenticated',
        fixHint: 'Sign in to GitHub with `gh auth login`.'
      })
    ]
    render(<ProviderStep setGate={vi.fn()} />)
    expect(await screen.findByText(/gh auth login/)).toBeTruthy()
    expect(screen.queryByText(/claude login/i)).toBeNull()
  })

  it('re-check re-probes every provider', async () => {
    render(<ProviderStep setGate={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /re-check/i }))
    expect(window.argus.providers.refresh).toHaveBeenCalled()
  })

  it('says so when nothing is enabled, and keeps the gate closed', async () => {
    const setGate = vi.fn()
    statuses = []
    render(<ProviderStep setGate={setGate} />)
    expect(await screen.findByText(/No providers are enabled/i)).toBeTruthy()
    await waitFor(() => expect(setGate).toHaveBeenCalledWith(false))
  })

  it('a rejected probe closes the gate rather than hanging on "checking"', async () => {
    const setGate = vi.fn()
    window.argus.providers.statuses = vi.fn(async () => {
      throw new Error('ipc down')
    }) as never
    render(<ProviderStep setGate={setGate} />)
    await waitFor(() => expect(setGate).toHaveBeenCalledWith(false))
    expect(screen.queryByText(/Checking your providers/)).toBeNull()
  })
})
