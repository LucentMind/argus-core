// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { CaseDashboard } from '../CaseDashboard'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseRecord } from '../../../../shared/types'
import { DEFAULT_MODE } from '../../../../shared/modes'

function payload(): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

function mkCase(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: 1,
    slug: 'NAV-1',
    title: 'Bearing jumps',
    jiraKey: 'NAV-1',
    jiraSyncedAt: null,
    jiraDeselected: [],
    jiraStatus: null,
    jiraPriority: null,
    jiraCommentCount: null,
    jiraAttachmentIds: [],
    reviewBaseline: null,
    lastSyncError: null,
    status: 'analyzing',
    resolution: null,
    activeMode: DEFAULT_MODE,
    tags: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    actionItems: [],
    ...overrides
  }
}

/** Relative to the real clock — these assertions must not rot with the date. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

const noopHandlers = {
  onOpen: vi.fn(),
  onNew: vi.fn(),
  onImport: vi.fn(),
  onDeleted: vi.fn()
}

beforeEach(() => {
  window.argus = {
    settings: { get: vi.fn(async () => payload()), onChanged: vi.fn(() => () => {}) },
    proposals: { list: vi.fn().mockResolvedValue({ proposals: [] }) },
    bundle: { export: vi.fn() },
    cases: { delete: vi.fn() },
    // The dashboard mounts usePrStatuses for every case, which reads the cache and
    // subscribes through these on mount.
    pr: {
      statusList: vi.fn(async () => ({})),
      statusRefresh: vi.fn(async () => ({})),
      onStatusChanged: vi.fn(() => () => {})
    },

    jira: {
      syncAll: vi.fn().mockResolvedValue({ ok: true, value: { synced: 0, failed: 0 } }),
      onSyncProgress: vi.fn(() => () => {})
    }
  } as never
  settingsStore.reset()
})

describe('CaseDashboard triage', () => {
  it('renders action items as chips', () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({
            actionItems: [{ kind: 'comments', severity: 'action', label: '2 new comments' }]
          })
        ]}
        {...noopHandlers}
      />
    )
    expect(screen.getByText('2 new comments')).toBeInTheDocument()
  })

  it('renders info items as muted text, not chips', () => {
    render(
      <CaseDashboard
        cases={[mkCase({ actionItems: [{ kind: 'idle', severity: 'info', label: 'idle 20d' }] })]}
        {...noopHandlers}
      />
    )
    expect(screen.getByText('idle 20d')).toBeInTheDocument()
  })

  it('shows sync recency in the footer well before the case goes stale', () => {
    render(
      <CaseDashboard
        cases={[mkCase({ jiraSyncedAt: daysAgo(2), actionItems: [] })]}
        {...noopHandlers}
      />
    )
    expect(screen.getByText(/synced 2d ago/)).toBeInTheDocument()
  })

  it('says "synced today" for a case synced within the day', () => {
    render(
      <CaseDashboard
        cases={[mkCase({ jiraSyncedAt: new Date().toISOString() })]}
        {...noopHandlers}
      />
    )
    expect(screen.getByText(/synced today/)).toBeInTheDocument()
  })

  it('shows no recency for a case with no jira key', () => {
    render(
      <CaseDashboard
        cases={[mkCase({ jiraKey: null, jiraSyncedAt: daysAgo(2) })]}
        {...noopHandlers}
      />
    )
    expect(screen.queryByText(/synced/)).not.toBeInTheDocument()
  })

  it('states the sync recency once — the stale chip does not repeat the footer', () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({
            jiraSyncedAt: daysAgo(9),
            actionItems: [{ kind: 'stale', severity: 'info', label: 'synced 9d ago' }]
          })
        ]}
        {...noopHandlers}
      />
    )
    expect(screen.getAllByText(/synced 9d ago/)).toHaveLength(1)
  })

  it('shows the jira priority', () => {
    render(<CaseDashboard cases={[mkCase({ jiraPriority: 'High' })]} {...noopHandlers} />)
    expect(screen.getByText(/High/)).toBeInTheDocument()
  })

  it('renders a sync failure on the card itself', () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({
            actionItems: [{ kind: 'sync-error', severity: 'action', label: 'sync failed — auth' }]
          })
        ]}
        {...noopHandlers}
      />
    )
    expect(screen.getByText('sync failed — auth')).toBeInTheDocument()
  })

  it('renders no action row when there is nothing to do', () => {
    render(<CaseDashboard cases={[mkCase({ actionItems: [] })]} {...noopHandlers} />)
    expect(screen.queryByTestId('action-items')).not.toBeInTheDocument()
  })

  it('hides closed cases by default and reveals them on toggle', async () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({ slug: 'live' }),
          mkCase({ slug: 'done', status: 'closed', resolution: 'solved' })
        ]}
        {...noopHandlers}
      />
    )
    expect(screen.queryByText('done')).not.toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Show closed cases'))
    expect(screen.getByText('done')).toBeInTheDocument()
  })

  it('filters cards by slug, title and jira key', async () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({ slug: 'alpha', title: 'One' }),
          mkCase({ slug: 'beta', title: 'Two', jiraKey: 'PROJ-9' })
        ]}
        {...noopHandlers}
      />
    )
    await userEvent.type(screen.getByPlaceholderText('Filter cases…'), 'PROJ-9')
    expect(screen.queryByText('alpha')).not.toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
  })

  it('shows counts by status', () => {
    render(
      <CaseDashboard
        cases={[mkCase({ slug: 'a', status: 'open' }), mkCase({ slug: 'b', status: 'analyzing' })]}
        {...noopHandlers}
      />
    )
    expect(screen.getByText(/1 open · 1 analyzing/)).toBeInTheDocument()
  })

  it('runs a bulk sync and reports the result', async () => {
    const syncAll = vi.fn().mockResolvedValue({
      ok: true,
      value: { total: 3, synced: 2, changed: 1, failed: 1, failures: [], finishedAt: '' }
    })
    window.argus.jira.syncAll = syncAll
    render(<CaseDashboard cases={[mkCase()]} {...noopHandlers} onDeleted={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Sync all' }))
    expect(syncAll).toHaveBeenCalled()
    expect(await screen.findByText('2 synced · 1 changed · 1 failed')).toBeInTheDocument()
  })

  it('ignores a progress event that lands after the run resolved', async () => {
    // Observed live: the final `syncing 3/3…` event arrived AFTER syncAll's
    // `finally` cleared `syncing`, re-disabling the button permanently with no
    // way to recover. The result line and the stuck button were on screen at
    // once. Ordering between the last progress send and the invoke reply is not
    // guaranteed, so the listener must ignore post-run events outright.
    let emit: ((p: { done: number; total: number }) => void) | undefined
    window.argus.jira.onSyncProgress = vi.fn((cb) => {
      emit = cb
      return () => {}
    })
    window.argus.jira.syncAll = vi.fn().mockResolvedValue({
      ok: true,
      value: { total: 3, synced: 3, changed: 0, failed: 0, failures: [], finishedAt: '' }
    })
    render(<CaseDashboard cases={[mkCase()]} {...noopHandlers} onDeleted={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Sync all' }))
    expect(await screen.findByText('3 synced · 0 changed · 0 failed')).toBeInTheDocument()

    await act(async () => {
      emit?.({ done: 3, total: 3 })
    })

    const btn = screen.getByRole('button', { name: 'Sync all' })
    expect(btn).toBeEnabled()
    expect(screen.queryByText(/syncing/)).not.toBeInTheDocument()
  })

  it('surfaces a sync failure', async () => {
    window.argus.jira.syncAll = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'auth', message: 'nope' })
    render(<CaseDashboard cases={[mkCase()]} {...noopHandlers} onDeleted={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Sync all' }))
    expect(await screen.findByText(/nope/)).toBeInTheDocument()
  })

  it('shows the Jira priority as a neutral pill, not as footer prose', () => {
    render(<CaseDashboard cases={[mkCase({ jiraPriority: 'High' })]} {...noopHandlers} />)
    const pill = screen.getByText('High')
    expect(pill.className).toContain('text-dim')
    expect(pill.className).not.toContain('text-danger')
  })

  it('omits the pill entirely when the case has no priority', () => {
    render(<CaseDashboard cases={[mkCase({ jiraPriority: null })]} {...noopHandlers} />)
    expect(screen.queryByText(/^(Highest|High|Medium|Low|Lowest)$/)).toBeNull()
  })

  it('pairs the status word with a glowing dot', () => {
    render(<CaseDashboard cases={[mkCase({ status: 'analyzing' })]} {...noopHandlers} />)
    expect(screen.getByText('Analyzing')).toBeTruthy()
    expect(screen.getAllByTestId('status-dot').length).toBeGreaterThan(0)
  })

  it('spells out the rca-drafted status', () => {
    render(<CaseDashboard cases={[mkCase({ status: 'rca-drafted' })]} {...noopHandlers} />)
    expect(screen.getByText('RCA drafted')).toBeTruthy()
  })

  it('clamps the title to two lines so one long title cannot desync a grid row', () => {
    render(
      <CaseDashboard
        cases={[mkCase({ title: 'CLONE - [NAV]Stopover reached too early and route missing' })]}
        {...noopHandlers}
      />
    )
    const title = screen.getByTestId('case-title')
    expect(title.className).toContain('line-clamp-2')
    expect(title.textContent).toBe('CLONE - [NAV]Stopover reached too early and route missing')
  })
})
