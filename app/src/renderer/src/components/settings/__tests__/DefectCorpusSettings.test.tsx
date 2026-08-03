// @vitest-environment jsdom
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { DefectCorpusSettings } from '../DefectCorpusSettings'
import { defaultSettings } from '../../../../../shared/settings'
import { corpusTokenSecret } from '../../../../../shared/defectCorpus'
import type { SettingsPayload } from '../../../../../shared/settings'
import type {
  DefectCorpusSourceCfg,
  CorpusAdminConfig,
  CorpusAdminResult,
  CorpusJqlPreview
} from '../../../../../shared/defectCorpus'

// Remove goes through the Argus confirm dialog, never window.confirm — stub it so tests can
// drive the confirm/cancel branches directly, same idiom as HivemindSettings.test.tsx.
vi.mock('../../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

import { confirm } from '../../../lib/confirmStore'

function payloadWith(sources: Record<string, DefectCorpusSourceCfg>): SettingsPayload {
  return {
    settings: { ...defaultSettings(), defectCorpus: { sources } },
    resolvedTools: [],
    dataRoot: { path: 'C:/tmp/argus', fromEnv: false },
    loadError: null
  }
}

const jiraSource: DefectCorpusSourceCfg = { name: 'Jira', baseUrl: '', enabled: true }

const okInfo = {
  name: 'Jira defects',
  contract: 'v1',
  projects: ['PLAT'],
  ticketCount: 4821,
  lastSyncAt: '2026-07-10T12:00:00.000Z',
  capabilities: { semantic: true, admin: true, enrichment: { distilled: 10, total: 20 } }
}

const adminConfig: CorpusAdminConfig = {
  jira: {
    baseUrl: 'https://jira.example.com',
    email: 'bot@example.com',
    apiToken: '••••••',
    jql: 'project = KAN',
    includeComments: true
  },
  sync: { intervalMinutes: 60 },
  embedding: { endpoint: 'https://embed.example.com', model: 'text-embed', apiKey: '••••••' },
  llm: { provider: 'anthropic', model: 'claude-3', apiKey: '••••••' },
  enrichment: { mode: 'rules', rulesJql: 'priority = High' }
}

function mockArgus(): void {
  ;(globalThis as unknown as { window: { argus: unknown } }).window.argus = {
    settings: { patch: vi.fn().mockResolvedValue(undefined) },
    secrets: {
      set: vi.fn().mockResolvedValue(undefined),
      has: vi.fn().mockResolvedValue(false),
      delete: vi.fn().mockResolvedValue(undefined)
    },
    defects: {
      test: vi.fn(),
      syncNow: vi.fn().mockResolvedValue({ ok: true }),
      syncStatus: vi.fn().mockResolvedValue(null),
      getConfig: vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'not configured', code: 'not_configured' }),
      putConfig: vi.fn().mockResolvedValue({ ok: true, value: adminConfig }),
      jqlPreview: vi.fn()
    }
  }
}

/** Runs Test with admin capability and waits for the resulting chips — the shared setup every
 *  ingestion-editor test needs before the expander even exists. */
async function testAdmin(card: HTMLElement): Promise<void> {
  fireEvent.click(within(card).getByRole('button', { name: 'Test' }))
  await within(card).findByText(/tickets/)
}

beforeEach(() => {
  mockArgus()
  vi.mocked(confirm).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DefectCorpusSettings', () => {
  it('adds a source and persists it via settingsStore.patch, keyed by a generated id', async () => {
    render(<DefectCorpusSettings payload={payloadWith({})} />)
    fireEvent.change(screen.getByLabelText('New source name'), {
      target: { value: 'Platform Jira' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }))
    expect(window.argus.settings.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        defectCorpus: {
          sources: {
            'platform-jira': expect.objectContaining({
              name: 'Platform Jira',
              baseUrl: '',
              enabled: true
            })
          }
        }
      })
    )
  })

  it('edits an existing source and persists the change via settingsStore.patch', async () => {
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    const baseUrl = within(card).getByLabelText('Base URL')
    fireEvent.change(baseUrl, { target: { value: 'https://corpus.example.com' } })
    fireEvent.blur(baseUrl)
    expect(window.argus.settings.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        defectCorpus: { sources: { jira: { baseUrl: 'https://corpus.example.com' } } }
      })
    )
  })

  it('commits the token via secrets.set, keyed by corpusTokenSecret(id), and never through settings', async () => {
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    const token = within(card).getByLabelText('API token')
    fireEvent.change(token, { target: { value: 'sk-super-secret-value' } })
    fireEvent.blur(token)
    expect(window.argus.secrets.set).toHaveBeenCalledWith(
      corpusTokenSecret('jira'),
      'sk-super-secret-value'
    )
    for (const call of vi.mocked(window.argus.settings.patch).mock.calls) {
      expect(JSON.stringify(call)).not.toContain('sk-super-secret-value')
    }
  })

  it('renders info chips when Test succeeds', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    fireEvent.click(within(card).getByRole('button', { name: 'Test' }))
    expect(await within(card).findByText('4821 tickets')).toBeInTheDocument()
    expect(within(card).getByText(/synced/)).toBeInTheDocument()
    expect(within(card).getByText('semantic ✓')).toBeInTheDocument()
    expect(within(card).getByText('admin ✓')).toBeInTheDocument()
  })

  it('renders the error inline when Test fails', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: false, error: 'unreachable host' })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    fireEvent.click(within(card).getByRole('button', { name: 'Test' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent('unreachable host')
  })

  it('shows Sync now only after a test reports admin capability', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({
      ok: true,
      info: { ...okInfo, capabilities: { ...okInfo.capabilities, admin: false } }
    })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    expect(within(card).queryByRole('button', { name: /sync now/i })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Test' }))
    await within(card).findByText(/tickets/)
    expect(within(card).queryByRole('button', { name: /sync now/i })).toBeNull()
  })

  it('shows Sync now once a test reports admin capability', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    expect(within(card).queryByRole('button', { name: /sync now/i })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Test' }))
    expect(await within(card).findByRole('button', { name: /sync now/i })).toBeInTheDocument()
  })

  it('removes a source through the confirm store, never window.confirm, and deletes its token', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm')
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Jira' }))
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Remove Jira?', danger: true })
    )
    expect(nativeConfirm).not.toHaveBeenCalled()
    await act(async () => {
      await Promise.resolve()
    })
    expect(window.argus.settings.patch).toHaveBeenCalledWith(
      expect.objectContaining({ defectCorpus: { sources: { jira: null } } })
    )
    expect(window.argus.secrets.delete).toHaveBeenCalledWith(corpusTokenSecret('jira'))
    nativeConfirm.mockRestore()
  })

  it('does not remove the source when the confirm dialog is cancelled', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false)
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Jira' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(window.argus.settings.patch).not.toHaveBeenCalled()
  })

  it('polls sync status while running and stops once it settles', async () => {
    vi.useFakeTimers()
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    const syncStatus = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        state: 'running',
        progress: { fetched: 10, upserted: 4, embedded: 0 },
        lastSyncAt: null,
        lastError: null
      })
      .mockResolvedValueOnce({
        state: 'idle',
        progress: null,
        lastSyncAt: '2026-08-03T00:00:00.000Z',
        lastError: null
      })
    window.argus.defects.syncStatus = syncStatus
    window.argus.defects.syncNow = vi.fn().mockResolvedValue({ ok: true })

    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })

    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Test' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const syncBtn = within(card).getByRole('button', { name: /sync now/i })
    await act(async () => {
      fireEvent.click(syncBtn)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(within(card).getByText(/syncing… 4\/10 tickets/)).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(within(card).getByText(/last synced/)).toBeInTheDocument()

    const callsAfterSettled = syncStatus.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(syncStatus.mock.calls.length).toBe(callsAfterSettled)
  })

  it('gives a new source a unique id when its name collides with an existing one', async () => {
    const existing: DefectCorpusSourceCfg = {
      name: 'Existing',
      baseUrl: 'https://original.example.com',
      enabled: false
    }
    render(<DefectCorpusSettings payload={payloadWith({ 'platform-jira': existing })} />)
    fireEvent.change(screen.getByLabelText('New source name'), {
      target: { value: 'Platform Jira' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }))
    // Exact match, not objectContaining: the patch payload must touch ONLY the freshly
    // generated id — if it also carried a 'platform-jira' key, the original entry's
    // baseUrl/enabled would be clobbered by settingsStore's deep merge.
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      defectCorpus: {
        sources: {
          'platform-jira-2': { name: 'Platform Jira', baseUrl: '', enabled: true }
        }
      }
    })
  })

  it('renders the error inline when Test rejects instead of resolving {ok:false}', async () => {
    window.argus.defects.test = vi.fn().mockRejectedValue(new Error('IPC channel closed'))
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    fireEvent.click(within(card).getByRole('button', { name: 'Test' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent('IPC channel closed')
  })
})

describe('DefectCorpusSettings ingestion editor', () => {
  it('does not render the ingestion expander when the last Test lacked admin capability', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({
      ok: true,
      info: { ...okInfo, capabilities: { ...okInfo.capabilities, admin: false } }
    })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    expect(within(card).queryByText(/ingestion settings/i)).toBeNull()
    await testAdmin(card)
    expect(within(card).queryByText(/ingestion settings/i)).toBeNull()
  })

  it('renders the ingestion expander, collapsed, once a test reports admin capability', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    expect(within(card).getByText(/ingestion settings/i)).toBeInTheDocument()
    expect(window.argus.defects.getConfig).not.toHaveBeenCalled()
    expect(within(card).queryByLabelText('Jira JQL')).toBeNull()
  })

  it('loads and seeds the form on first expansion, and does not refetch on a later re-expand', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    const toggle = within(card).getByRole('button', { name: /ingestion settings/i })
    fireEvent.click(toggle)
    expect(await within(card).findByLabelText('Jira JQL')).toHaveValue('project = KAN')
    expect(within(card).getByLabelText('Jira API token')).toHaveValue('••••••')
    expect(window.argus.defects.getConfig).toHaveBeenCalledTimes(1)
    expect(window.argus.defects.getConfig).toHaveBeenCalledWith('jira')

    // Collapse (not dirty, no confirm) then re-expand: cached draft, no second fetch.
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(within(card).getByLabelText('Jira JQL')).toHaveValue('project = KAN')
    expect(window.argus.defects.getConfig).toHaveBeenCalledTimes(1)
  })

  it('seeds the EMPTY_CONFIG draft and shows a setup note when the corpus has no config yet', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({
      ok: false,
      error: 'no config',
      code: 'not_configured'
    })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    expect(
      await within(card).findByText(/saving creates this corpus's ingestion config/i)
    ).toBeInTheDocument()
    expect(within(card).getByLabelText('Jira JQL')).toHaveValue('')
    expect(within(card).getByLabelText('Sync interval (minutes)')).toHaveValue(60)
    expect(within(card).getByLabelText('Jira API token')).toHaveValue('')
  })

  it('shows an inline error, without crashing, when getConfig fails', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({
      ok: false,
      error: 'corpus unreachable'
    })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    expect(await within(card).findByText('corpus unreachable')).toBeInTheDocument()
  })

  // Finding 2 (final review, corpus-admin-editor): `toggle()` only fetched when
  // `load.status === 'idle'`, so after a transient failure the error state was terminal —
  // collapsing and re-expanding just redisplayed the stale error forever, with no way to
  // retry short of reloading Settings entirely.
  it('retries the fetch on re-expand after a failed load, instead of leaving the error terminal', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'corpus unreachable' })
      .mockResolvedValueOnce({ ok: true, value: adminConfig })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    const toggle = within(card).getByRole('button', { name: /ingestion settings/i })

    fireEvent.click(toggle)
    expect(await within(card).findByText('corpus unreachable')).toBeInTheDocument()

    // Collapse (an error state carries no unsaved draft, so this must not go through confirm).
    fireEvent.click(toggle)
    expect(confirm).not.toHaveBeenCalled()

    // Re-expand: the second getConfig call succeeds and the form renders.
    fireEvent.click(toggle)
    expect(await within(card).findByLabelText('Jira JQL')).toHaveValue('project = KAN')
    expect(window.argus.defects.getConfig).toHaveBeenCalledTimes(2)
  })

  it('shows an inline error, without crashing, when getConfig rejects instead of resolving {ok:false}', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockRejectedValue(new Error('IPC channel closed'))
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    expect(await within(card).findByRole('alert')).toHaveTextContent('IPC channel closed')
  })

  it('shows the re-test message when getConfig reports the forbidden code', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({
      ok: false,
      error: 'no admin scope',
      code: 'forbidden'
    })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    expect(
      await within(card).findByText(/admin scope required — re-test the connection/i)
    ).toBeInTheDocument()
  })

  it('enables Save when dirty, and sends the untouched mask as-is alongside the changed field', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    await within(card).findByLabelText('Jira JQL')

    const saveBtn = within(card).getByRole('button', { name: 'Save' })
    expect(saveBtn).toBeDisabled()
    const interval = within(card).getByLabelText('Sync interval (minutes)')
    fireEvent.change(interval, { target: { value: '90' } })
    expect(saveBtn).toBeEnabled()
    fireEvent.click(saveBtn)
    expect(window.argus.defects.putConfig).toHaveBeenCalledWith(
      'jira',
      expect.objectContaining({
        sync: { intervalMinutes: 90 },
        jira: expect.objectContaining({ apiToken: '••••••' })
      })
    )
  })

  it('omits empty secret fields from the PUT body for a fresh (not_configured) draft', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({
      ok: false,
      error: 'no config',
      code: 'not_configured'
    })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    const jql = await within(card).findByLabelText('Jira JQL')
    fireEvent.change(jql, { target: { value: 'project = KAN' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    const body = vi.mocked(window.argus.defects.putConfig).mock.calls[0][1] as CorpusAdminConfig
    expect(body.jira).not.toHaveProperty('apiToken')
    expect(body.embedding).not.toHaveProperty('apiKey')
    expect(body.llm).not.toHaveProperty('apiKey')
  })

  it('drives the LLM provider and enrichment mode SelectFields, updating the draft', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    await within(card).findByLabelText('Jira JQL')

    // adminConfig loads with enrichment.mode: 'rules', so the rules-JQL textarea starts visible.
    expect(within(card).getByLabelText('Enrichment rules JQL')).toBeInTheDocument()

    fireEvent.click(within(card).getByRole('combobox', { name: 'LLM provider' }))
    fireEvent.click(within(card).getByRole('option', { name: 'openai-compatible' }))

    fireEvent.click(within(card).getByRole('combobox', { name: 'Enrichment mode' }))
    fireEvent.click(within(card).getByRole('option', { name: 'off' }))

    // Switching mode away from 'rules' hides the rules-JQL field.
    expect(within(card).queryByLabelText('Enrichment rules JQL')).toBeNull()

    const saveBtn = within(card).getByRole('button', { name: 'Save' })
    expect(saveBtn).toBeEnabled()
    fireEvent.click(saveBtn)
    const body = vi.mocked(window.argus.defects.putConfig).mock.calls[0][1] as CorpusAdminConfig
    expect(body.llm.provider).toBe('openai-compatible')
    expect(body.enrichment.mode).toBe('off')
  })

  // Finding 1 (final review, corpus-admin-editor): the contract's `AdminConfig.llm` carries an
  // optional `endpoint` (needed for `provider: 'openai-compatible'`), but the LLM group only
  // rendered provider/model/apiKey — there was no way for an admin to set it.
  it('renders the LLM endpoint field, seeded from the loaded draft, and sends edits in the PUT body', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({
      ok: true,
      value: { ...adminConfig, llm: { ...adminConfig.llm, endpoint: 'https://llm.example.com/v1' } }
    })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    const endpoint = await within(card).findByLabelText('LLM endpoint')
    expect(endpoint).toHaveValue('https://llm.example.com/v1')

    fireEvent.change(endpoint, { target: { value: 'https://new-llm.example.com/v1' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    const body = vi.mocked(window.argus.defects.putConfig).mock.calls[0][1] as CorpusAdminConfig
    expect(body.llm.endpoint).toBe('https://new-llm.example.com/v1')
  })

  it('omits the LLM endpoint from the PUT body when left empty (it is optional, not a valid empty string)', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({
      ok: false,
      error: 'no config',
      code: 'not_configured'
    })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    const jql = await within(card).findByLabelText('Jira JQL')
    fireEvent.change(jql, { target: { value: 'project = KAN' } })
    expect(within(card).getByLabelText('LLM endpoint')).toHaveValue('')
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    const body = vi.mocked(window.argus.defects.putConfig).mock.calls[0][1] as CorpusAdminConfig
    expect(body.llm).not.toHaveProperty('endpoint')
  })

  it('sends a typed secret value in the PUT body', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    const token = await within(card).findByLabelText('Jira API token')
    fireEvent.change(token, { target: { value: 'new-secret-token' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    const body = vi.mocked(window.argus.defects.putConfig).mock.calls[0][1] as CorpusAdminConfig
    expect(body.jira.apiToken).toBe('new-secret-token')
  })

  it('re-seeds the draft from the masked response and disables Save after a successful save', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    window.argus.defects.putConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    const token = await within(card).findByLabelText('Jira API token')
    fireEvent.change(token, { target: { value: 'new-secret-token' } })
    const saveBtn = within(card).getByRole('button', { name: 'Save' })
    await act(async () => {
      fireEvent.click(saveBtn)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(within(card).getByLabelText('Jira API token')).toHaveValue('••••••')
    expect(saveBtn).toBeDisabled()
  })

  it('shows an inline error, without crashing, when putConfig rejects instead of resolving {ok:false}', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    window.argus.defects.putConfig = vi.fn().mockRejectedValue(new Error('save channel closed'))
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    const interval = await within(card).findByLabelText('Sync interval (minutes)')
    fireEvent.change(interval, { target: { value: '90' } })
    const saveBtn = within(card).getByRole('button', { name: 'Save' })
    fireEvent.click(saveBtn)
    expect(await within(card).findByRole('alert')).toHaveTextContent('save channel closed')
    // The draft is kept (still dirty) rather than discarded on a failed save.
    expect(saveBtn).toBeEnabled()
  })

  it('confirms before discarding dirty ingestion edits on collapse, and keeps them on cancel', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false)
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    const toggle = within(card).getByRole('button', { name: /ingestion settings/i })
    fireEvent.click(toggle)
    await within(card).findByLabelText('Jira JQL')
    const interval = within(card).getByLabelText('Sync interval (minutes)')
    fireEvent.change(interval, { target: { value: '5' } })

    fireEvent.click(toggle)
    await act(async () => {
      await Promise.resolve()
    })
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Discard ingestion changes?' })
    )
    // Still expanded, edits kept — the field is still present and holds the typed value.
    expect(within(card).getByLabelText('Jira JQL')).toBeInTheDocument()
    expect(within(card).getByLabelText('Sync interval (minutes)')).toHaveValue(5)
  })

  it('discards dirty ingestion edits and collapses when the confirm dialog is confirmed', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await testAdmin(card)
    const toggle = within(card).getByRole('button', { name: /ingestion settings/i })
    fireEvent.click(toggle)
    await within(card).findByLabelText('Jira JQL')
    fireEvent.change(within(card).getByLabelText('Sync interval (minutes)'), {
      target: { value: '5' }
    })

    fireEvent.click(toggle) // confirm mock resolves true by default (see beforeEach/mockArgus)
    await act(async () => {
      await Promise.resolve()
    })
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Discard ingestion changes?' })
    )
    // Collapsed — the form is gone.
    expect(within(card).queryByLabelText('Jira JQL')).toBeNull()

    // Re-expanding shows the reverted (last-loaded) value, not the discarded edit — and does
    // not re-fetch, since the draft was reverted in place rather than cleared.
    fireEvent.click(toggle)
    expect(within(card).getByLabelText('Sync interval (minutes)')).toHaveValue(60)
    expect(window.argus.defects.getConfig).toHaveBeenCalledTimes(1)
  })
})

describe('DefectCorpusSettings ingestion editor JQL preview', () => {
  /** Expands the card's ingestion editor (post-Test) and waits for the Jira JQL field, which
   *  is present for every `adminConfig`-seeded test below since `getConfig` is stubbed there. */
  async function expandIngestion(card: HTMLElement): Promise<void> {
    await testAdmin(card)
    fireEvent.click(within(card).getByRole('button', { name: /ingestion settings/i }))
    await within(card).findByLabelText('Jira JQL')
  }

  it('calls jqlPreview with the current draft JQL text, not the loaded value', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    window.argus.defects.jqlPreview = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { count: 431, sample: [] } })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await expandIngestion(card)

    const jql = within(card).getByLabelText('Jira JQL')
    fireEvent.change(jql, { target: { value: 'project = FOO' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Preview Jira JQL' }))

    expect(window.argus.defects.jqlPreview).toHaveBeenCalledWith('jira', 'project = FOO')
  })

  it('renders the count and up to 5 sample rows on a successful preview', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    window.argus.defects.jqlPreview = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        count: 431,
        sample: [
          { key: 'KAN-1', summary: 'First ticket' },
          { key: 'KAN-2', summary: 'Second ticket' }
        ]
      }
    })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await expandIngestion(card)

    fireEvent.click(within(card).getByRole('button', { name: 'Preview Jira JQL' }))

    expect(await within(card).findByText('431 matching tickets')).toBeInTheDocument()
    expect(within(card).getByText('KAN-1 — First ticket')).toBeInTheDocument()
    expect(within(card).getByText('KAN-2 — Second ticket')).toBeInTheDocument()
  })

  it('caps sample rows at 5 when the server returns more, and a later preview on the same field replaces it', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    const sevenSample = Array.from({ length: 7 }, (_, i) => ({
      key: `KAN-${i + 1}`,
      summary: `Ticket ${i + 1}`
    }))
    window.argus.defects.jqlPreview = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { count: 8, sample: sevenSample } })
      .mockResolvedValueOnce({
        ok: true,
        value: { count: 2, sample: [{ key: 'KAN-9', summary: 'Replaced' }] }
      })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await expandIngestion(card)

    const previewBtn = within(card).getByRole('button', { name: 'Preview Jira JQL' })
    fireEvent.click(previewBtn)
    expect(await within(card).findByText('8 matching tickets')).toBeInTheDocument()
    for (let i = 1; i <= 5; i++) {
      expect(within(card).getByText(`KAN-${i} — Ticket ${i}`)).toBeInTheDocument()
    }
    expect(within(card).queryByText(/KAN-6/)).toBeNull()
    expect(within(card).queryByText(/KAN-7/)).toBeNull()

    // Re-running Preview on the SAME field replaces the prior result wholesale.
    fireEvent.click(previewBtn)
    expect(await within(card).findByText('2 matching tickets')).toBeInTheDocument()
    expect(within(card).getByText('KAN-9 — Replaced')).toBeInTheDocument()
    expect(within(card).queryByText('8 matching tickets')).toBeNull()
    expect(within(card).queryByText(/KAN-1 —/)).toBeNull()
  })

  it('renders an invalid_jql failure under the right field, leaving the other field untouched', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    window.argus.defects.jqlPreview = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'field X does not exist', code: 'invalid_jql' })
      .mockResolvedValueOnce({ ok: true, value: { count: 12, sample: [] } })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await expandIngestion(card)

    // adminConfig loads with enrichment.mode: 'rules', so the rules-JQL field is present too.
    fireEvent.click(within(card).getByRole('button', { name: 'Preview Jira JQL' }))
    expect(await within(card).findByText('field X does not exist')).toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: 'Preview enrichment rules JQL' }))
    expect(await within(card).findByText('12 matching tickets')).toBeInTheDocument()

    // The Jira field's error is per-field state — untouched by the other field's preview.
    expect(within(card).getByText('field X does not exist')).toBeInTheDocument()
  })

  it('shows an inline error, without crashing, when jqlPreview rejects instead of resolving {ok:false}', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    window.argus.defects.jqlPreview = vi.fn().mockRejectedValue(new Error('preview channel closed'))
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await expandIngestion(card)

    fireEvent.click(within(card).getByRole('button', { name: 'Preview Jira JQL' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent('preview channel closed')
  })

  it('disables the Preview button while its field is empty, and enables it once text is typed', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({
      ok: false,
      error: 'no config',
      code: 'not_configured'
    })
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await expandIngestion(card)

    const previewBtn = within(card).getByRole('button', { name: 'Preview Jira JQL' })
    expect(previewBtn).toBeDisabled()

    fireEvent.change(within(card).getByLabelText('Jira JQL'), {
      target: { value: 'project = KAN' }
    })
    expect(previewBtn).toBeEnabled()
  })

  it('disables the Preview button while a preview request is in flight', async () => {
    window.argus.defects.test = vi.fn().mockResolvedValue({ ok: true, info: okInfo })
    window.argus.defects.getConfig = vi.fn().mockResolvedValue({ ok: true, value: adminConfig })
    let resolvePreview: (v: CorpusAdminResult<CorpusJqlPreview>) => void = () => {}
    window.argus.defects.jqlPreview = vi.fn(
      () =>
        new Promise<CorpusAdminResult<CorpusJqlPreview>>((resolve) => {
          resolvePreview = resolve
        })
    )
    render(<DefectCorpusSettings payload={payloadWith({ jira: jiraSource })} />)
    const card = screen.getByRole('group', { name: 'Jira' })
    await expandIngestion(card)

    const previewBtn = within(card).getByRole('button', { name: 'Preview Jira JQL' })
    fireEvent.click(previewBtn)
    expect(previewBtn).toBeDisabled()

    await act(async () => {
      resolvePreview({ ok: true, value: { count: 1, sample: [] } })
      await Promise.resolve()
    })
    expect(previewBtn).toBeEnabled()
  })
})
