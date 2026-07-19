// @vitest-environment jsdom
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentSettings } from '../settings/AgentSettings'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { ProviderStatus } from '../../../../shared/types'

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

function status(over?: Partial<ProviderStatus>): ProviderStatus {
  return {
    instanceId: 'claude-default',
    driverKind: 'claude-agent-sdk',
    displayName: 'Claude',
    state: 'ready',
    detail: 'claude ready',
    checkedAt: new Date().toISOString(),
    ...over
  }
}

let statuses: ProviderStatus[]
beforeEach(() => {
  settingsStore.reset()
  statuses = [status()]
  window.argus = {
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async () => payload()),
      onChanged: vi.fn(() => () => {})
    },
    providers: {
      statuses: vi.fn(async () => statuses),
      refresh: vi.fn(async () => statuses),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

/** Adds a second, Copilot-backed instance. */
function withCopilot(p: SettingsPayload): void {
  p.settings.agent.providerInstances['copilot-1'] = {
    driver: 'github-copilot',
    enabled: true,
    config: {}
  }
}

describe('AgentSettings provider list', () => {
  it('renders one row per instance in a single section — no separate detail card', async () => {
    render(<AgentSettings payload={payload(withCopilot)} />)
    expect((await screen.findByTestId('provider-label-claude-default')).textContent).toBe('Claude')
    expect(screen.getByTestId('provider-label-copilot-1').textContent).toBe('Copilot')
    // the old flow had a chip rail that only *selected* an instance plus a card for the
    // selected one; both are gone
    expect(screen.queryByRole('button', { name: /switch to/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /test connection/i })).toBeNull()
  })

  it('shows the authenticated account for a ready provider', async () => {
    statuses = [status({ email: 'x@y.z', subscription: 'Claude Max', version: '2.1.204' })]
    render(<AgentSettings payload={payload()} />)
    expect(await screen.findByText(/authenticated as/i)).toBeTruthy()
    expect(screen.getByText('Claude Max', { exact: false })).toBeTruthy()
    expect(screen.getByText('v2.1.204')).toBeTruthy()
  })

  it('shows the failure detail AND the driver-owned fix hint when a provider errors', async () => {
    statuses = [
      status({
        state: 'error',
        detail: 'copilot not authenticated',
        fixHint: 'Sign in to GitHub with `gh auth login`.'
      })
    ]
    render(<AgentSettings payload={payload()} />)
    expect(await screen.findByText('copilot not authenticated')).toBeTruthy()
    expect(screen.getByText(/gh auth login/)).toBeTruthy()
  })

  it('surfaces an update advisory when the CLI is behind, without offering to install it', async () => {
    statuses = [
      status({
        version: '2.1.200',
        latestVersion: '2.1.204',
        updateCommand: 'npm install -g @anthropic-ai/claude-code@latest'
      })
    ]
    render(<AgentSettings payload={payload()} />)
    expect(await screen.findByText('v2.1.204')).toBeTruthy()
    expect(screen.getByTitle(/npm install -g @anthropic-ai\/claude-code@latest/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /update now/i })).toBeNull()
  })

  it('toggling a provider off patches enabled without touching the others', async () => {
    render(<AgentSettings payload={payload(withCopilot)} />)
    fireEvent.click(await screen.findByLabelText('Enable Copilot'))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: { providerInstances: { 'copilot-1': { enabled: false } } }
    })
  })

  it('hands the default role to another enabled provider when the default is switched off', async () => {
    // Background work (distillation, refsync, probes) has no model picker to fall back to,
    // so the default must never point at a disabled provider.
    render(<AgentSettings payload={payload(withCopilot)} />)
    fireEvent.click(await screen.findByLabelText('Enable Claude'))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: {
        providerInstances: { 'claude-default': { enabled: false } },
        activeInstanceId: 'copilot-1'
      }
    })
  })

  it('leaves the default alone when disabling a non-default provider', async () => {
    render(<AgentSettings payload={payload(withCopilot)} />)
    fireEvent.click(await screen.findByLabelText('Enable Copilot'))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: { providerInstances: { 'copilot-1': { enabled: false } } }
    })
  })

  it('expands a row to reveal display name, driver config and the models section', async () => {
    render(<AgentSettings payload={payload()} />)
    expect(screen.queryByLabelText('Claude CLI path')).toBeNull()
    fireEvent.click(await screen.findByLabelText('Expand Claude settings'))
    expect(screen.getByLabelText('Display name · claude-default')).toBeTruthy()
    expect(screen.getByLabelText('Claude CLI path')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Collapse Claude settings'))
    expect(screen.queryByLabelText('Claude CLI path')).toBeNull()
  })

  it('expands only one provider at a time', async () => {
    render(<AgentSettings payload={payload(withCopilot)} />)
    fireEvent.click(await screen.findByLabelText('Expand Claude settings'))
    fireEvent.click(screen.getByLabelText('Expand Copilot settings'))
    expect(screen.getByLabelText('Copilot CLI path')).toBeTruthy()
    expect(screen.queryByLabelText('Claude CLI path')).toBeNull()
  })

  it('editing the CLI path patches that instance’s config envelope', async () => {
    render(<AgentSettings payload={payload()} />)
    fireEvent.click(await screen.findByLabelText('Expand Claude settings'))
    const input = screen.getByLabelText('Claude CLI path')
    fireEvent.change(input, { target: { value: 'C:/claude.exe' } })
    fireEvent.blur(input)
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: { providerInstances: { 'claude-default': { config: { cliPath: 'C:/claude.exe' } } } }
    })
  })

  it('unknown driver renders an unavailable badge instead of a row', async () => {
    const p = payload((p) => {
      p.settings.agent.providerInstances['claude-default'].driver = 'mystery-driver'
    })
    render(<AgentSettings payload={p} />)
    expect(await screen.findByText(/unavailable driver: mystery-driver/)).toBeTruthy()
  })
})

describe('AgentSettings provider status refresh', () => {
  it('reads statuses on mount and re-reads when the main process says they changed', async () => {
    let fire: (() => void) | null = null
    window.argus.providers.onChanged = vi.fn((cb: () => void) => {
      fire = cb
      return () => {}
    }) as never
    render(<AgentSettings payload={payload()} />)
    await screen.findByTestId('provider-label-claude-default')
    expect(window.argus.providers.statuses).toHaveBeenCalledTimes(1)

    statuses = [status({ state: 'error', detail: 'logged out' })]
    fire!()
    expect(await screen.findByText('logged out')).toBeTruthy()
  })

  it('the refresh button re-probes every provider', async () => {
    render(<AgentSettings payload={payload()} />)
    fireEvent.click(await screen.findByLabelText('Refresh provider status'))
    expect(window.argus.providers.refresh).toHaveBeenCalled()
  })

  it('shows how long ago the newest probe ran', async () => {
    render(<AgentSettings payload={payload()} />)
    expect(await screen.findByText(/Checked just now/)).toBeTruthy()
  })

  it('renders no checked-label before any probe has completed', async () => {
    statuses = [status({ state: 'checking', checkedAt: null })]
    render(<AgentSettings payload={payload()} />)
    await screen.findByTestId('provider-label-claude-default')
    expect(screen.queryByText(/Checked/)).toBeNull()
  })
})

describe('AgentSettings add provider', () => {
  it('does not offer a driver that is already added', async () => {
    render(<AgentSettings payload={payload()} />)
    fireEvent.click(await screen.findByLabelText('Add provider'))
    expect(screen.queryByRole('menuitem', { name: 'Claude Agent SDK' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'GitHub Copilot' })).toBeTruthy()
  })

  it('adding a provider creates the instance and expands it, without changing the default', async () => {
    render(<AgentSettings payload={payload()} />)
    fireEvent.click(await screen.findByLabelText('Add provider'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'GitHub Copilot' }))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: {
        providerInstances: {
          'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
        }
      }
    })
  })

  it('hides the add affordance once every driver is present', async () => {
    render(<AgentSettings payload={payload(withCopilot)} />)
    await screen.findByTestId('provider-label-copilot-1')
    expect(screen.queryByLabelText('Add provider')).toBeNull()
  })
})

describe('AgentSettings session defaults', () => {
  it('session-default rows still patch agent keys', async () => {
    render(<AgentSettings payload={payload()} />)
    const input = await screen.findByLabelText('Max concurrent sessions')
    fireEvent.change(input, { target: { value: '5' } })
    expect(window.argus.settings.patch).toHaveBeenCalledWith({ agent: { maxSessions: 5 } })
  })

  it('provider rows and session defaults are distinct sections', async () => {
    render(<AgentSettings payload={payload()} />)
    const providers = (await screen.findByText('Providers')).closest('section')!
    expect(within(providers).getByTestId('provider-label-claude-default')).toBeTruthy()
    expect(within(providers).queryByLabelText('Max concurrent sessions')).toBeNull()
  })

  it('tags the default provider and only that one', async () => {
    render(<AgentSettings payload={payload(withCopilot)} />)
    expect(await screen.findByTestId('provider-default-claude-default')).toBeTruthy()
    expect(screen.queryByTestId('provider-default-copilot-1')).toBeNull()
    expect(
      screen.getByTitle('Used for new chats and background work (distillation, reference sync)')
        .textContent
    ).toBe('Default')
  })

  it('tags the provider actually in use when the stored default is disabled', async () => {
    // defaultInstanceId() falls back to the first enabled instance at read time, and THAT is
    // what seeds new chats and runs distillation. Tagging the stale stored id would lie.
    const p = payload((p) => {
      withCopilot(p)
      p.settings.agent.providerInstances['claude-default'].enabled = false
      p.settings.agent.activeInstanceId = 'claude-default'
    })
    render(<AgentSettings payload={p} />)
    expect(await screen.findByTestId('provider-default-copilot-1')).toBeTruthy()
    expect(screen.queryByTestId('provider-default-claude-default')).toBeNull()
  })
})
