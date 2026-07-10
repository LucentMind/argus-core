// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentSettings } from '../settings/AgentSettings'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { AuthStatus } from '../../../../shared/types'

function payload(mut?: (p: SettingsPayload) => void): SettingsPayload {
  const p: SettingsPayload = {
    settings: defaultSettings(),
    resolvedTools: {
      traceDir: { value: null, source: 'default' },
      parseBin: { value: null, source: 'default' }
    },
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
  mut?.(p)
  return p
}

function mockAuth(overrides?: Partial<AuthStatus>): AuthStatus {
  return { ok: true, detail: 'claude ready (claude-fable-5)', ...overrides }
}

function authStatusMock(status: AuthStatus): (force?: boolean) => Promise<AuthStatus> {
  return vi.fn(async () => status)
}

function expandCard(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Expand provider details' }))
}

beforeEach(() => {
  settingsStore.reset()
  window.argus = {
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async () => payload()),
      onChanged: vi.fn(() => () => {})
    },
    agent: { authStatus: authStatusMock(mockAuth()) }
  } as never
})

describe('AgentSettings', () => {
  it('fetches cached auth on mount, shows the driver badge, and keeps the body collapsed by default', async () => {
    render(<AgentSettings payload={payload()} />)
    expect(screen.getByText('Claude Agent SDK')).toBeTruthy()
    expect(screen.queryByLabelText('Claude CLI path')).toBeNull()
    expect(screen.queryByText(/Models ·/)).toBeNull()
    await vi.waitFor(() => expect(window.argus.agent.authStatus).toHaveBeenCalledWith())
  })

  it('expanding the card reveals display name, annotation config (model excluded), and the Models section', async () => {
    render(<AgentSettings payload={payload()} />)
    await vi.waitFor(() => expect(window.argus.agent.authStatus).toHaveBeenCalled())
    expandCard()
    expect(screen.getByLabelText('Display name')).toBeTruthy()
    expect(screen.getByLabelText('Claude CLI path')).toBeTruthy()
    expect(screen.queryByLabelText('Model')).toBeNull()
    expect(screen.getByText(/Models ·/)).toBeTruthy()
  })

  it('collapsing again hides the body', async () => {
    render(<AgentSettings payload={payload()} />)
    expandCard()
    expect(screen.getByLabelText('Claude CLI path')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse provider details' }))
    expect(screen.queryByLabelText('Claude CLI path')).toBeNull()
  })

  it('renders the version and a blurred email that reveals the real value on click', async () => {
    window.argus.agent.authStatus = authStatusMock(
      mockAuth({
        email: 'jdoe@example.com',
        subscription: 'Claude Max Subscription',
        version: '2.1.204'
      })
    )
    render(<AgentSettings payload={payload()} />)
    expect(await screen.findByText('v2.1.204')).toBeTruthy()
    const emailBtn = await screen.findByLabelText('Toggle account email visibility')
    expect(emailBtn.textContent).not.toBe('jdoe@example.com')
    expect(screen.getByText(/Claude Max Subscription/)).toBeTruthy()
    fireEvent.click(emailBtn)
    expect(emailBtn.textContent).toBe('jdoe@example.com')
  })

  it('shows a danger line with the probe detail when auth fails', async () => {
    window.argus.agent.authStatus = authStatusMock({ ok: false, detail: 'not logged in' })
    render(<AgentSettings payload={payload()} />)
    const line = await screen.findByText('not logged in')
    expect(line.className).toMatch(/text-danger/)
  })

  it('editing the CLI path patches the instance config envelope', async () => {
    render(<AgentSettings payload={payload()} />)
    expandCard()
    const cliPath = screen.getByLabelText('Claude CLI path')
    fireEvent.change(cliPath, { target: { value: '/usr/local/bin/claude' } })
    fireEvent.blur(cliPath)
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: {
        providerInstances: {
          'claude-default': { config: { cliPath: '/usr/local/bin/claude' } }
        }
      }
    })
  })

  it('session-default rows patch agent keys (unaffected by the collapsible card)', () => {
    render(<AgentSettings payload={payload()} />)
    fireEvent.change(screen.getByLabelText('Default permission mode'), {
      target: { value: 'Plan mode' }
    })
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: { defaultPermissionMode: 'plan' }
    })
    fireEvent.change(screen.getByLabelText('Max concurrent sessions'), { target: { value: '5' } })
    expect(window.argus.settings.patch).toHaveBeenCalledWith({ agent: { maxSessions: 5 } })
    const persona = screen.getByLabelText('Persona append')
    fireEvent.change(persona, { target: { value: 'be brief' } })
    fireEvent.blur(persona)
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: { personaAppend: 'be brief' }
    })
  })

  it('Test connection forces a fresh auth probe', async () => {
    render(<AgentSettings payload={payload()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await vi.waitFor(() => expect(window.argus.agent.authStatus).toHaveBeenCalledWith(true))
  })

  it('unknown driver → unavailable badge, config fields hidden even when expanded', () => {
    const p = payload((p) => {
      p.settings.agent.providerInstances['claude-default'].driver = 'mystery-driver'
    })
    render(<AgentSettings payload={p} />)
    expect(screen.getByText(/unavailable driver/i)).toBeTruthy()
    expandCard()
    expect(screen.queryByLabelText('Claude CLI path')).toBeNull()
  })
})
