// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConnectorsSettings } from '../settings/ConnectorsSettings'
import { connectorsStore } from '../../lib/connectorsStore'
import { DEFAULT_PRESETS, type ConnectorsPayload } from '../../../../shared/connectors'

const basePayload = (over: Partial<ConnectorsPayload> = {}): ConnectorsPayload => ({
  connectors: {
    rovo: {
      kind: 'http',
      displayName: 'Atlassian Rovo',
      preset: 'rovo',
      enabled: true,
      config: { url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse', oauth: true },
      lastDiscovered: {
        at: '2026-07-10T00:00:00Z',
        tools: [
          { name: 'getJiraIssue', risk: 'low' },
          { name: 'addCommentToJiraIssue', risk: 'medium' },
          { name: 'deleteJiraIssue', risk: 'high' }
        ]
      }
    },
    local: { kind: 'stdio', enabled: false, config: { command: 'npx', args: ['-y', 'x'] } },
    odd: { kind: 'future-kind', enabled: true, config: {} }
  },
  runtime: {
    rovo: { state: 'connected', at: '2026-07-10T00:00:00Z', toolCount: 3 },
    local: { state: 'never-connected' },
    odd: { state: 'never-connected' }
  },
  oauth: { rovo: 'authorized', local: 'not-authorized', odd: 'not-authorized' },
  loadError: null,
  secretsAvailable: true,
  secretsLoadError: null,
  presets: DEFAULT_PRESETS,
  ...over
})

let currentPayload: ConnectorsPayload

beforeEach(() => {
  connectorsStore.reset()
  currentPayload = basePayload()
  window.confirm = vi.fn(() => true)
  window.argus = {
    connectors: {
      get: vi.fn(() => Promise.resolve(currentPayload)),
      patch: vi.fn(() => Promise.resolve(currentPayload)),
      test: vi.fn().mockResolvedValue({ ok: true, tools: [] }),
      oauth: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: vi.fn(() => () => {})
    },
    secrets: {
      set: vi.fn().mockResolvedValue(undefined),
      has: vi.fn().mockResolvedValue(false),
      delete: vi.fn().mockResolvedValue(undefined)
    }
  } as never
})

describe('ConnectorsSettings', () => {
  it('renders one card per instance with kind, status and tool summary', async () => {
    render(<ConnectorsSettings />)
    expect(await screen.findByText('Atlassian Rovo')).toBeTruthy()
    expect(screen.getByText('connected')).toBeTruthy()
    expect(screen.getByText('3 tools · 1 low · 1 medium · 1 high')).toBeTruthy()
    expect(screen.getByText('disabled')).toBeTruthy() // the local card
    expect(screen.getByText(/unsupported kind: future-kind/)).toBeTruthy()
  })

  it('expanding the tool list shows per-tool risk chips', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /tools · rovo/i }))
    expect(screen.getByText('getJiraIssue')).toBeTruthy()
    expect(screen.getByText('deleteJiraIssue')).toBeTruthy()
    expect(screen.getAllByText('high')).not.toHaveLength(0)
  })

  it('enable switch patches enabled; remove confirms then patches null', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click((await screen.findAllByRole('switch'))[0])
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({ rovo: { enabled: false } })
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0])
    expect(window.confirm).toHaveBeenCalled()
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({ rovo: null })
  })

  it('Test connection calls the probe IPC; Authorize calls oauth', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click((await screen.findAllByRole('button', { name: /test connection/i }))[0])
    expect(window.argus.connectors.test).toHaveBeenCalledWith('rovo')
    fireEvent.click(screen.getByRole('button', { name: /re-authorize/i }))
    expect(window.argus.connectors.oauth).toHaveBeenCalledWith('rovo')
  })

  it('add chooser creates the Rovo preset or a unique custom instance', async () => {
    currentPayload = basePayload({ connectors: {}, runtime: {}, oauth: {} })
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /add connector/i }))
    fireEvent.click(screen.getByRole('button', { name: /atlassian rovo/i }))
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({
      rovo: expect.objectContaining({ kind: 'http', preset: 'rovo' })
    })
    fireEvent.click(screen.getByRole('button', { name: /custom local \(stdio\)/i }))
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({
      'stdio-1': expect.objectContaining({ kind: 'stdio' })
    })
  })

  it('editing the Rovo card shows the PAT extra; committing the token writes the secret then the ref', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /edit · rovo/i }))
    const token = screen.getByLabelText('Atlassian API token (PAT)')
    fireEvent.change(token, { target: { value: 'atl-tok' } })
    fireEvent.blur(token)
    await vi.waitFor(() =>
      expect(window.argus.secrets.set).toHaveBeenCalledWith('connector/rovo/apiToken', 'atl-tok')
    )
    await vi.waitFor(() =>
      expect(window.argus.connectors.patch).toHaveBeenCalledWith({
        rovo: { config: { apiToken: { $secret: 'connector/rovo/apiToken' } } }
      })
    )
  })

  it('resetting a set secret deletes the stored secret and nulls the config ref', async () => {
    currentPayload = basePayload()
    currentPayload.connectors.rovo.config = {
      ...(currentPayload.connectors.rovo.config as Record<string, unknown>),
      apiToken: { $secret: 'connector/rovo/apiToken' }
    } as never
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /edit · rovo/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset Atlassian API token (PAT)' }))
    expect(window.argus.secrets.delete).toHaveBeenCalledWith('connector/rovo/apiToken')
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({
      rovo: { config: { apiToken: null } }
    })
    expect(window.argus.secrets.set).not.toHaveBeenCalled()
  })

  it('invalid JSON in the env field commits nothing; valid JSON commits the parsed object', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /edit · local/i }))
    const env = screen.getByLabelText(/Environment \(JSON object/)
    fireEvent.change(env, { target: { value: '{not json' } })
    fireEvent.blur(env)
    expect(window.argus.connectors.patch).not.toHaveBeenCalled()
    fireEvent.change(env, { target: { value: '{"A":"1"}' } })
    fireEvent.blur(env)
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({
      local: { config: { env: { A: '1' } } }
    })
  })

  it('banner on loadError; secret-store chip when unavailable and config references secrets', async () => {
    currentPayload = basePayload({
      loadError: 'mcp-servers.json could not be parsed',
      secretsAvailable: false,
      connectors: {
        s: { kind: 'stdio', enabled: true, config: { command: 'x', env: { T: { $secret: 'n' } } } }
      },
      runtime: { s: { state: 'never-connected' } },
      oauth: { s: 'not-authorized' }
    })
    render(<ConnectorsSettings />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/secret store unavailable/)).toBeTruthy()
  })
})
