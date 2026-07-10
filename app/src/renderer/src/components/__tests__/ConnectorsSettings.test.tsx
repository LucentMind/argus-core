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
          {
            name: 'getJiraIssue',
            risk: 'low',
            description: 'Search across the Docs and issues in Jira.'
          },
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
  rest: {},
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
    },
    sourceControl: {
      status: vi.fn().mockResolvedValue({
        installed: true,
        version: 'gh version 2.96.0 (2026-07-02)',
        authenticated: true,
        login: 'jiawiehan',
        detail: 'Logged in to github.com account jiawiehan'
      })
    },
    openExternal: vi.fn()
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

  it('line 1 shows name/kind/status + menu + switch; standalone Test/Remove buttons are gone', async () => {
    render(<ConnectorsSettings />)
    await screen.findByText('Atlassian Rovo')
    expect(screen.queryByRole('button', { name: /test connection/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^remove · /i })).toBeNull()
    expect(screen.getAllByRole('button', { name: /actions · /i })).toHaveLength(3)
  })

  it('expanding the tool list shows per-tool risk chips', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /tools · rovo/i }))
    expect(screen.getByText('getJiraIssue')).toBeTruthy()
    expect(screen.getByText('deleteJiraIssue')).toBeTruthy()
    expect(screen.getAllByText('high')).not.toHaveLength(0)
  })

  it('tool list rows are name + chip only', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /tools · rovo/i }))
    expect(screen.getByText('getJiraIssue')).toBeTruthy()
    expect(screen.queryByText(/Search across/)).toBeNull() // fixture description not rendered
  })

  it('enable switch patches enabled; remove via the menu confirms then patches null', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click((await screen.findAllByRole('switch'))[0])
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({ rovo: { enabled: false } })
    fireEvent.click(screen.getByRole('button', { name: 'actions · rovo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    expect(window.confirm).toHaveBeenCalled()
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({ rovo: null })
  })

  it('menu actions: Edit details toggles the form, Test connection probes, Remove confirms', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'actions · rovo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Test connection' }))
    expect(window.argus.connectors.test).toHaveBeenCalledWith('rovo')
    fireEvent.click(screen.getByRole('button', { name: 'actions · rovo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    expect(window.confirm).toHaveBeenCalled()
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({ rovo: null })
  })

  it('authorized oauth card: no Authorize on the face, Re-authorize in the menu', async () => {
    render(<ConnectorsSettings />) // fixture rovo oauth: 'authorized'
    await screen.findByText('Atlassian Rovo')
    expect(screen.queryByRole('button', { name: /authorize · rovo/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'actions · rovo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Re-authorize' }))
    expect(window.argus.connectors.oauth).toHaveBeenCalledWith('rovo')
  })

  it('authorized oauth card: menu Re-authorize failure surfaces the inline error', async () => {
    ;(window.argus.connectors.oauth as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'boom'
    })
    render(<ConnectorsSettings />) // fixture rovo oauth: 'authorized'
    await screen.findByText('Atlassian Rovo')
    fireEvent.click(screen.getByRole('button', { name: 'actions · rovo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Re-authorize' }))
    expect(await screen.findByText('boom')).toBeTruthy()
  })

  it('unauthorized oauth card shows Authorize…, disabled without url, inline error on failure', async () => {
    currentPayload = basePayload({
      oauth: { rovo: 'not-authorized', nourl: 'not-authorized' },
      connectors: {
        rovo: {
          kind: 'http',
          preset: 'rovo',
          enabled: true,
          config: { url: 'https://x', oauth: true }
        },
        nourl: { kind: 'http', enabled: true, config: { url: '', oauth: true } }
      },
      runtime: { rovo: { state: 'never-connected' }, nourl: { state: 'never-connected' } }
    })
    ;(window.argus.connectors.oauth as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'redirect_uri mismatch'
    })
    render(<ConnectorsSettings />)
    const auth = (await screen.findByRole('button', {
      name: 'authorize · rovo'
    })) as HTMLButtonElement
    expect(auth.textContent).toContain('Authorize')
    expect(auth.textContent).not.toContain('Re-authorize')
    expect(
      (screen.getByRole('button', { name: 'authorize · nourl' }) as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.click(auth)
    expect(await screen.findByText(/redirect_uri mismatch/)).toBeTruthy()
  })

  it('Add connector is a dropdown built from presets + customs', async () => {
    currentPayload = basePayload({ connectors: {}, runtime: {}, oauth: {} })
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /add connector/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Atlassian Rovo' }))
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({
      rovo: expect.objectContaining({
        kind: 'http',
        preset: 'rovo',
        config: expect.objectContaining({
          oauth: true,
          url: expect.stringContaining('atlassian.com')
        })
      })
    })
    fireEvent.click(screen.getByRole('button', { name: /add connector/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Custom local (stdio)' }))
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({
      'stdio-1': expect.objectContaining({ kind: 'stdio' })
    })
  })

  it('Add connector dropdown excludes reserved-id presets (e.g. "argus")', async () => {
    currentPayload = basePayload({
      connectors: {},
      runtime: {},
      oauth: {},
      presets: {
        ...DEFAULT_PRESETS,
        argus: { displayName: 'Argus (reserved)', kind: 'http', config: {}, links: {} }
      }
    })
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /add connector/i }))
    expect(screen.queryByRole('menuitem', { name: 'Argus (reserved)' })).toBeNull()
  })

  it('edit form shows the PAT field and the create-token link beside its label', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'actions · rovo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit details' }))
    expect(screen.getByLabelText('Atlassian API token (PAT)')).toBeTruthy()
    const createTokenBtn = screen.getByRole('button', { name: 'create api token · rovo' })
    // the link now sits beside the PAT label rather than below the whole form
    expect(createTokenBtn.closest('span')?.textContent).toContain('Atlassian API token (PAT)')
    fireEvent.click(createTokenBtn)
    expect(window.argus.openExternal).toHaveBeenCalledWith(
      'https://id.atlassian.com/manage-profile/security/api-tokens'
    )
  })

  it('committing the token writes the secret then the ref', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'actions · rovo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit details' }))
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
    fireEvent.click(await screen.findByRole('button', { name: 'actions · rovo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset Atlassian API token (PAT)' }))
    expect(window.argus.secrets.delete).toHaveBeenCalledWith('connector/rovo/apiToken')
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({
      rovo: { config: { apiToken: null } }
    })
    expect(window.argus.secrets.set).not.toHaveBeenCalled()
  })

  it('invalid JSON in the env field commits nothing; valid JSON commits the parsed object', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'actions · local' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit details' }))
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
