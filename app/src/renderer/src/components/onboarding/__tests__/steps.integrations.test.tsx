// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { IntegrationsStep } from '../steps'
import * as store from '../../../lib/onboardingStore'
import { settingsStore } from '../../../lib/settingsStore'
import { connectorsStore } from '../../../lib/connectorsStore'
import { defaultSettings } from '../../../../../shared/settings'

const ROVO_PRESET = {
  kind: 'http',
  displayName: 'Atlassian Rovo',
  config: { url: 'https://mcp.atlassian.com/v1/mcp/authv2', transport: 'http', oauth: true },
  links: {}
}

function settingsPayload(repo = ''): unknown {
  const s = defaultSettings()
  s.hivemind.repo = repo
  return { settings: s, resolvedTools: [], dataRoot: { path: '', fromEnv: false }, loadError: null }
}
function connPayload(over: Record<string, unknown> = {}): unknown {
  return {
    connectors: {},
    runtime: {},
    oauth: {},
    rest: {},
    loadError: null,
    secretsAvailable: true,
    secretsLoadError: null,
    presets: { rovo: ROVO_PRESET },
    ...over
  }
}

let settingsPatch: ReturnType<typeof vi.fn>
let connPatch: ReturnType<typeof vi.fn>
let oauth: ReturnType<typeof vi.fn>

let secretsSet: ReturnType<typeof vi.fn>

function setup(
  opts: {
    repo?: string
    oauthState?: string
    hasRovo?: boolean
    rovoConfig?: Record<string, unknown>
  } = {}
): void {
  settingsPatch = vi.fn(async () => settingsPayload(opts.repo))
  connPatch = vi.fn(async () => connPayload())
  oauth = vi.fn(async () => ({ ok: true }))
  secretsSet = vi.fn(async () => undefined)
  const rovo =
    opts.hasRovo || opts.rovoConfig
      ? { rovo: { kind: 'http', enabled: true, config: opts.rovoConfig ?? {} } }
      : {}
  window.argus = {
    settings: {
      get: vi.fn(async () => settingsPayload(opts.repo)),
      patch: settingsPatch,
      onChanged: vi.fn(() => () => {})
    },
    connectors: {
      get: vi.fn(async () =>
        connPayload({
          oauth: opts.oauthState ? { rovo: opts.oauthState } : {},
          connectors: rovo
        })
      ),
      patch: connPatch,
      oauth,
      onChanged: vi.fn(() => () => {})
    },
    secrets: { set: secretsSet },
    openExternal: vi.fn()
  } as never
  settingsStore.reset()
  connectorsStore.reset()
}

afterEach(() => {
  vi.restoreAllMocks()
  settingsStore.reset()
  connectorsStore.reset()
})

describe('IntegrationsStep (inline config)', () => {
  it('shows Configured and records flags when Atlassian is authorized and a repo is set', async () => {
    setup({ repo: 'org/hive', oauthState: 'authorized' })
    const spy = vi.spyOn(store, 'markIntegration').mockResolvedValue()
    render(<IntegrationsStep />)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('jira', true))
    expect(spy).toHaveBeenCalledWith('confluence', true)
    expect(spy).toHaveBeenCalledWith('hive', true)
    await waitFor(() => expect(screen.getAllByText('Configured')).toHaveLength(2))
  })

  it('commits the HiveMind repo inline (no trip to Settings)', async () => {
    setup()
    render(<IntegrationsStep />)
    const input = await screen.findByLabelText('HiveMind repo')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'org/hive' } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(settingsPatch).toHaveBeenCalledWith({ hivemind: { repo: 'org/hive' } })
    )
  })

  it('Connect Atlassian creates the rovo instance then runs OAuth', async () => {
    setup()
    render(<IntegrationsStep />)
    const btn = await screen.findByRole('button', { name: /connect atlassian/i })
    fireEvent.click(btn)
    await waitFor(() =>
      expect(connPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          rovo: expect.objectContaining({ preset: 'rovo', enabled: true, kind: 'http' })
        })
      )
    )
    await waitFor(() => expect(oauth).toHaveBeenCalledWith('rovo'))
  })

  it('Connect Atlassian skips instance creation when a rovo connector already exists', async () => {
    setup({ hasRovo: true })
    render(<IntegrationsStep />)
    const btn = await screen.findByRole('button', { name: /connect atlassian/i })
    fireEvent.click(btn)
    await waitFor(() => expect(oauth).toHaveBeenCalledWith('rovo'))
    expect(connPatch).not.toHaveBeenCalled()
  })

  it('surfaces an OAuth failure inline without configuring', async () => {
    setup()
    oauth.mockResolvedValue({ ok: false, error: 'user cancelled' })
    render(<IntegrationsStep />)
    fireEvent.click(await screen.findByRole('button', { name: /connect atlassian/i }))
    await waitFor(() => expect(screen.getByText(/user cancelled/i)).toBeTruthy())
  })

  it('the Atlassian card is Authorize-only — no REST toggle or token fields (Part 3a)', async () => {
    setup()
    render(<IntegrationsStep />)
    await screen.findByRole('button', { name: /connect atlassian/i })
    expect(screen.queryByRole('button', { name: /REST API/i })).toBeNull()
    expect(screen.queryByLabelText('Site URL (REST, optional)')).toBeNull()
    expect(screen.queryByLabelText('Atlassian API token (optional)')).toBeNull()
  })

  it('does not show Configured from a stale siteUrl/apiToken config without OAuth authorized', async () => {
    setup({
      rovoConfig: {
        siteUrl: 'https://acme.atlassian.net',
        apiToken: { $secret: 'connector/rovo/apiToken' }
      }
    })
    const spy = vi.spyOn(store, 'markIntegration').mockResolvedValue()
    render(<IntegrationsStep />)
    await screen.findByRole('button', { name: /connect atlassian/i })
    expect(screen.queryByText('Configured')).toBeNull()
    expect(spy).not.toHaveBeenCalledWith('jira', true)
  })
})
