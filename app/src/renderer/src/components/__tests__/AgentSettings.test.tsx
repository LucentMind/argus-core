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
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
  mut?.(p)
  return p
}

function mockAuth(overrides?: Partial<AuthStatus>): AuthStatus {
  return { ok: true, verified: false, detail: 'claude ready (claude-fable-5)', ...overrides }
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
  it('fetches cached auth on mount, shows the Claude header, and keeps the body collapsed by default', async () => {
    render(<AgentSettings payload={payload()} />)
    expect(screen.getByTestId('active-driver-label').textContent).toBe('Claude')
    expect(screen.queryByText('claude-default')).toBeNull()
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
    window.argus.agent.authStatus = authStatusMock({
      ok: false,
      verified: false,
      detail: 'not logged in'
    })
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

function withCopilotInstance(p: SettingsPayload): void {
  p.settings.agent.providerInstances['copilot-1'] = {
    driver: 'github-copilot',
    enabled: true,
    config: {}
  }
}

describe('AgentSettings provider picker', () => {
  it('renders every provider instance with the active one marked', () => {
    render(<AgentSettings payload={payload(withCopilotInstance)} />)
    expect(screen.getByRole('button', { name: 'Switch to Claude Agent SDK' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Switch to GitHub Copilot' })).toBeTruthy()
    expect(screen.getByText('active')).toBeTruthy()
  })

  it('clicking an inactive instance switches activeInstanceId via the settings bridge', () => {
    render(<AgentSettings payload={payload(withCopilotInstance)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to GitHub Copilot' }))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: { activeInstanceId: 'copilot-1' }
    })
  })

  it('clicking the already-active instance is a no-op', () => {
    render(<AgentSettings payload={payload(withCopilotInstance)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Claude Agent SDK' }))
    expect(window.argus.settings.patch).not.toHaveBeenCalled()
  })

  it('disables switching to a disabled instance', () => {
    const p = payload((p) => {
      withCopilotInstance(p)
      p.settings.agent.providerInstances['copilot-1'].enabled = false
    })
    render(<AgentSettings payload={p} />)
    const btn = screen.getByRole('button', { name: 'Switch to GitHub Copilot' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(btn)
    expect(window.argus.settings.patch).not.toHaveBeenCalled()
  })

  it('adding a provider creates a new instance for that driver and activates it', () => {
    render(<AgentSettings payload={payload()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'GitHub Copilot' }))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: {
        providerInstances: {
          'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
        },
        activeInstanceId: 'github-copilot-1'
      }
    })
  })

  it('does not offer a driver that is already added', () => {
    // The default payload already has a Claude instance; Copilot is still addable.
    render(<AgentSettings payload={payload()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
    // With no delete affordance a second Claude instance would be permanent, so it must
    // not be offered at all.
    expect(screen.queryByRole('menuitem', { name: 'Claude Agent SDK' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'GitHub Copilot' })).toBeTruthy()
  })

  it('hides the Add provider button entirely once every driver is added', () => {
    render(<AgentSettings payload={payload(withCopilotInstance)} />)
    expect(screen.queryByRole('button', { name: 'Add provider' })).toBeNull()
  })
})

describe('AgentSettings provider icon', () => {
  it('renders a distinct glyph per driver rather than the Claude mark for all', () => {
    const { container: claude } = render(<AgentSettings payload={payload()} />)
    const claudePath = claude.querySelector('svg path')?.getAttribute('d')

    const copilotActive = payload((p) => {
      withCopilotInstance(p)
      p.settings.agent.activeInstanceId = 'copilot-1'
    })
    const { container: copilot } = render(<AgentSettings payload={copilotActive} />)
    const copilotPath = copilot.querySelector('svg path')?.getAttribute('d')

    expect(claudePath).toBeTruthy()
    expect(copilotPath).toBeTruthy()
    expect(copilotPath).not.toBe(claudePath)
  })
})
