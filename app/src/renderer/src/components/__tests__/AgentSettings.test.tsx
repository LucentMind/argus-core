// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentSettings } from '../settings/AgentSettings'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'

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

beforeEach(() => {
  settingsStore.reset()
  window.argus = {
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async () => payload()),
      onChanged: vi.fn(() => () => {})
    },
    agent: { authStatus: vi.fn(async () => ({ ok: true, detail: 'claude ready' })) }
  } as never
})

describe('AgentSettings', () => {
  it('renders the driver badge and annotation-driven config fields', () => {
    render(<AgentSettings payload={payload()} />)
    expect(screen.getByText('Claude Agent SDK')).toBeTruthy()
    expect(screen.getByLabelText('Model')).toBeTruthy()
    expect(screen.getByLabelText('Claude CLI path')).toBeTruthy()
  })

  it('editing the model patches the instance config envelope', () => {
    render(<AgentSettings payload={payload()} />)
    const model = screen.getByLabelText('Model')
    fireEvent.change(model, { target: { value: 'claude-sonnet-5' } })
    fireEvent.blur(model)
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      agent: {
        providerInstances: {
          'claude-default': { config: { model: 'claude-sonnet-5' } }
        }
      }
    })
  })

  it('session-default rows patch agent keys', () => {
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

  it('Test connection forces a fresh auth probe and shows the chip', async () => {
    render(<AgentSettings payload={payload()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText('auth ✓')).toBeTruthy()
    expect(window.argus.agent.authStatus).toHaveBeenCalledWith(true)
  })

  it('unknown driver → unavailable badge, config fields hidden', () => {
    const p = payload((p) => {
      p.settings.agent.providerInstances['claude-default'].driver = 'mystery-driver'
    })
    render(<AgentSettings payload={p} />)
    expect(screen.getByText(/unavailable driver/i)).toBeTruthy()
    expect(screen.queryByLabelText('Model')).toBeNull()
  })
})
