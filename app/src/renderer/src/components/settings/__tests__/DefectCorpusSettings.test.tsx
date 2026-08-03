// @vitest-environment jsdom
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { DefectCorpusSettings } from '../DefectCorpusSettings'
import { defaultSettings } from '../../../../../shared/settings'
import { corpusTokenSecret } from '../../../../../shared/defectCorpus'
import type { SettingsPayload } from '../../../../../shared/settings'
import type { DefectCorpusSourceCfg } from '../../../../../shared/defectCorpus'

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
      syncStatus: vi.fn().mockResolvedValue(null)
    }
  }
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
