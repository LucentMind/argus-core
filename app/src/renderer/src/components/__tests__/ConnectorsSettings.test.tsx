// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectorsSettings } from '../settings/ConnectorsSettings'
import { connectorsStore } from '../../lib/connectorsStore'
import { settingsStore } from '../../lib/settingsStore'
import { confirm } from '../../lib/confirmStore'
import { DEFAULT_PRESETS, type ConnectorsPayload } from '../../../../shared/connectors'
import { defaultSettings, settingsSchema, type SettingsPayload } from '../../../../shared/settings'

vi.mock('../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

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
let currentSettings: SettingsPayload

const settingsPayload = (
  over: {
    rca?: Partial<SettingsPayload['settings']['rca']>
    watermark?: Partial<SettingsPayload['settings']['watermark']>
  } = {}
): SettingsPayload => {
  const s = defaultSettings()
  return {
    settings: {
      ...s,
      rca: { ...s.rca, ...over.rca },
      watermark: { ...s.watermark, ...over.watermark }
    },
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

beforeEach(() => {
  connectorsStore.reset()
  settingsStore.reset()
  currentPayload = basePayload()
  currentSettings = settingsPayload()
  vi.mocked(confirm).mockResolvedValue(true)
  window.argus = {
    connectors: {
      get: vi.fn(() => Promise.resolve(currentPayload)),
      patch: vi.fn(() => Promise.resolve(currentPayload)),
      test: vi.fn().mockResolvedValue({ ok: true, tools: [] }),
      oauth: vi.fn().mockResolvedValue({ ok: true }),
      oauthCode: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: vi.fn(() => () => {})
    },
    settings: {
      get: vi.fn(() => Promise.resolve(currentSettings)),
      patch: vi.fn((p: Record<string, Record<string, unknown>>) => {
        const merged = { ...currentSettings.settings } as Record<string, unknown>
        // Shallow per-section merge — enough for the sections this suite exercises (rca,
        // watermark, jira), and it no longer silently drops every section but rca.
        for (const [section, value] of Object.entries(p)) {
          const next = { ...(merged[section] as object), ...value } as Record<string, unknown>
          // main's deepMerge DELETES a key patched with null; the re-parse below then re-seeds
          // that key's schema default. Reproducing it here is what makes the reset idiom
          // (`{ x: null }`) testable at all — without it a null lands in the payload verbatim.
          for (const [k, v] of Object.entries(value)) if (v === null) delete next[k]
          merged[section] = next
        }
        currentSettings = {
          ...currentSettings,
          settings: settingsSchema.parse(merged) as SettingsPayload['settings']
        }
        return Promise.resolve(currentSettings)
      }),
      onChanged: vi.fn(() => () => {})
    },
    jira: {
      // The Jira section fetches the site's link-type catalogue on mount.
      linkTypes: vi.fn().mockResolvedValue({ ok: true, value: [] })
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
    expect(screen.getByLabelText('connected')).toBeTruthy()
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
    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(window.argus.connectors.patch).toHaveBeenCalledWith({ rovo: null }))
  })

  it('menu actions: Edit details toggles the form, Test connection probes, Remove confirms', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'actions · rovo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Test connection' }))
    expect(window.argus.connectors.test).toHaveBeenCalledWith('rovo')
    fireEvent.click(screen.getByRole('button', { name: 'actions · rovo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(window.argus.connectors.patch).toHaveBeenCalledWith({ rovo: null }))
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

  it('edit form has no PAT/site-URL fields — the Rovo card is Authorize-only (Part 3a)', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'actions · rovo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit details' }))
    expect(screen.queryByLabelText('Atlassian API token (optional)')).toBeNull()
    expect(screen.queryByLabelText(/Site URL/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'create api token · rovo' })).toBeNull()
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

  it('shows a REST auth chip when payload.rest carries an error for the instance', async () => {
    currentPayload.rest = {
      rovo: 'Atlassian rejected the API token (HTTP 401) — check the token and Site URL on the connector.'
    }
    render(<ConnectorsSettings />)
    const chip = await screen.findByText('REST auth')
    expect(chip).toHaveAttribute('title', expect.stringContaining('HTTP 401'))
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

  // The RCA report section moved to Settings -> Agent (user-directed, 2026-08-21); its
  // three cases moved with it, to settings/__tests__/RcaReportSettings.test.tsx.

  describe('Comment watermark settings (task 5)', () => {
    it('toggles the Jira watermark', async () => {
      render(<ConnectorsSettings />)
      await userEvent.click(await screen.findByLabelText('Watermark Jira comments'))
      expect(window.argus.settings.patch).toHaveBeenCalledWith({
        watermark: { jira: { enabled: false } }
      })
    })

    it('disables the text field of a target that is off', async () => {
      render(<ConnectorsSettings />) // github defaults to enabled:false
      expect(await screen.findByLabelText('GitHub watermark text')).toBeDisabled()
      expect(screen.getByLabelText('Jira watermark text')).not.toBeDisabled()
    })

    it('commits edited watermark text', async () => {
      render(<ConnectorsSettings />)
      const input = await screen.findByLabelText('Jira watermark text')
      await userEvent.clear(input)
      await userEvent.type(input, '_Drafted by a robot._')
      await userEvent.tab() // DraftInput commits on blur
      expect(window.argus.settings.patch).toHaveBeenCalledWith({
        watermark: { jira: { text: '_Drafted by a robot._' } }
      })
    })
  })

  describe('the Jira section', () => {
    // Only rendered with an Atlassian connector configured (user-directed, 2026-08-21): every
    // row in it is about how Argus reads Jira. Its contents have their own suite,
    // settings/__tests__/JiraSettings.test.tsx.
    it('renders when a rovo-preset connector exists', async () => {
      render(<ConnectorsSettings />)
      expect(await screen.findByText('Clone link types')).toBeInTheDocument()
    })

    it('is absent when no Atlassian connector is configured', async () => {
      currentPayload = basePayload({
        connectors: { local: { kind: 'stdio', enabled: false, config: { command: 'npx' } } },
        runtime: { local: { state: 'never-connected' } },
        oauth: { local: 'not-authorized' }
      })
      render(<ConnectorsSettings />)
      await screen.findByText('MCP connectors')
      expect(screen.queryByText('Clone link types')).toBeNull()
    })
  })

  describe('Slack connector card', () => {
    // clientId defaults to a real value: a redirectUrl-configured connector with no Client ID
    // is the exact dead end task 3 fixes (Authorize reaches the SDK's dynamic-client-registration
    // fallback and fails), so the shared fixture must not reproduce it for tests that aren't
    // about that guard. The dedicated 'Authorize is disabled without a Client ID' test below
    // overrides it back to '' to exercise that case specifically.
    const withSlack = (configOver: Record<string, unknown> = {}): ConnectorsPayload =>
      basePayload({
        connectors: {
          slack: {
            kind: 'http',
            displayName: 'Slack',
            preset: 'slack',
            enabled: true,
            config: {
              url: 'https://mcp.slack.com/mcp',
              transport: 'http',
              oauth: true,
              clientId: 'client-123',
              redirectUrl: 'http://localhost:8080/callback',
              ...configOver
            }
          }
        },
        runtime: { slack: { state: 'never-connected' } },
        oauth: { slack: 'not-authorized' }
      })

    it('Authorize is disabled when a redirectUrl is configured but no Client ID is set yet', async () => {
      // Reproduces the default first-click experience on a freshly-added Slack preset:
      // DEFAULT_PRESETS pre-fills redirectUrl but not clientId. Without this the SDK reaches
      // dynamic client registration and fails with "Incompatible auth server: does not support
      // dynamic client registration" — a confusing error for an unfilled field.
      currentPayload = withSlack({ clientId: '' })
      render(<ConnectorsSettings />)
      const auth = (await screen.findByLabelText('authorize · slack')) as HTMLButtonElement
      expect(auth.disabled).toBe(true)
    })

    it('Authorize is enabled once a Client ID is entered', async () => {
      currentPayload = withSlack() // clientId: 'client-123' by default
      render(<ConnectorsSettings />)
      const auth = (await screen.findByLabelText('authorize · slack')) as HTMLButtonElement
      expect(auth.disabled).toBe(false)
    })

    it('a Rovo card (no clientId, no redirectUrl configured) is unaffected by the guard', async () => {
      currentPayload = basePayload({
        oauth: { rovo: 'not-authorized' },
        connectors: {
          rovo: {
            kind: 'http',
            preset: 'rovo',
            enabled: true,
            config: {
              url: 'https://mcp.atlassian.com/v1/mcp/authv2',
              transport: 'http',
              oauth: true
            }
          }
        },
        runtime: { rovo: { state: 'never-connected' } }
      })
      render(<ConnectorsSettings />)
      const auth = (await screen.findByLabelText('authorize · rovo')) as HTMLButtonElement
      expect(auth.disabled).toBe(false)
    })

    it('shows the confidential-client fields when editing, and hides them on a Rovo card', async () => {
      currentPayload = withSlack()
      render(<ConnectorsSettings />)
      await userEvent.click(await screen.findByLabelText('actions · slack'))
      await userEvent.click(screen.getByText('Edit details'))
      // Exact labels, not a /Client ID/i regex: with clientId now non-default (fixture sets
      // 'client-123', so Authorize isn't disabled per task 3), AnnotatedForm also renders a
      // "Reset Client ID" button, which a substring/regex match on "Client ID" would also hit.
      expect(await screen.findByLabelText('Client ID')).toBeInTheDocument()
      expect(screen.getByLabelText(/Client secret/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/User scopes/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/Redirect URL/i)).toBeInTheDocument()
    })

    it('no client fields on the Rovo card', async () => {
      render(<ConnectorsSettings />) // basePayload() — rovo only
      await userEvent.click(await screen.findByLabelText('actions · rovo'))
      await userEvent.click(screen.getByText('Edit details'))
      await screen.findByLabelText('display name · rovo')
      expect(screen.queryByLabelText(/Client ID/i)).not.toBeInTheDocument()
    })

    it('needsCode reveals a paste field, and submitting it calls oauthCode', async () => {
      currentPayload = withSlack()
      vi.mocked(window.argus.connectors.oauth).mockResolvedValue({ ok: false, needsCode: true })
      render(<ConnectorsSettings />)
      await userEvent.click(await screen.findByLabelText('authorize · slack'))
      const input = await screen.findByLabelText('authorization code · slack')
      await userEvent.type(input, 'pasted-code')
      await userEvent.click(screen.getByLabelText('submit code · slack'))
      await waitFor(() =>
        expect(window.argus.connectors.oauthCode).toHaveBeenCalledWith('slack', 'pasted-code')
      )
    })

    it('a plain failure shows the error and no paste field', async () => {
      currentPayload = withSlack()
      vi.mocked(window.argus.connectors.oauth).mockResolvedValue({
        ok: false,
        error: 'bad_client_secret'
      })
      render(<ConnectorsSettings />)
      await userEvent.click(await screen.findByLabelText('authorize · slack'))
      expect(await screen.findByText('bad_client_secret')).toBeInTheDocument()
      expect(screen.queryByLabelText('authorization code · slack')).not.toBeInTheDocument()
    })

    it('two rapid Enter presses on the code input submit only once (in-flight guard)', async () => {
      currentPayload = withSlack()
      vi.mocked(window.argus.connectors.oauth).mockResolvedValue({ ok: false, needsCode: true })
      let resolveOauthCode!: (r: { ok: boolean }) => void
      const pending = new Promise<{ ok: boolean }>((resolve) => {
        resolveOauthCode = resolve
      })
      vi.mocked(window.argus.connectors.oauthCode).mockReturnValue(pending)
      render(<ConnectorsSettings />)
      await userEvent.click(await screen.findByLabelText('authorize · slack'))
      const input = await screen.findByLabelText('authorization code · slack')
      await userEvent.type(input, 'pasted-code')

      // Two Enter presses while the first exchange is still in flight — the OAuth code is
      // single-use, so a second oauthCode call with the same code would come back as an error.
      fireEvent.keyDown(input, { key: 'Enter' })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(window.argus.connectors.oauthCode).toHaveBeenCalledTimes(1)

      resolveOauthCode({ ok: true })
      await waitFor(() =>
        expect(screen.queryByLabelText('authorization code · slack')).not.toBeInTheDocument()
      )
    })
  })
})
