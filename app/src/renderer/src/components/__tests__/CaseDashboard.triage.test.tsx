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
    status: 'open',
    resolution: null,
    phase: 'open',
    activeMode: DEFAULT_MODE,
    tags: [],
    createdAt: '2026-07-01T00:00:00Z',
    // Relative, not a literal: the card renders `updated <age>` in its context line, so a fixed
    // date here makes that string wander with the calendar (`29d ago` today, `30d ago` tomorrow).
    updatedAt: daysAgo(2),
    actionItems: [],
    ...overrides
  }
}

/**
 * Relative to the real clock — these assertions must not rot with the date. Ages built this way
 * are exact (`formatSyncAge` floors epoch milliseconds, so `daysAgo(9)` always reads `9d ago`),
 * but match them against a specific slot, not the whole card: a bare /9d ago/ also matches the
 * tail of `29d ago` elsewhere on it.
 */
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
  it('renders comment volume as an icon and a total, not as prose — the tooltip carries what is new', () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({
            // Total (12) and fresh (2) are deliberately different values: this pins down that
            // the card shows the SIZE of the conversation, not the delta since the last look —
            // Task 11 moved that delta into the tooltip.
            jiraCommentCount: 12,
            actionItems: [
              { kind: 'comments', severity: 'action', label: '2 new comments', count: 2 }
            ]
          })
        ]}
        {...noopHandlers}
      />
    )
    const metric = screen.getByTestId('metric-comments')
    expect(metric.textContent).toBe('12')
    expect(metric.getAttribute('title')).toBe('12 comments · 2 new')
    expect(screen.queryByText('2 new comments')).toBeNull()
  })

  it('never reddens comments or attachments, however many there are', () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({
            actionItems: [
              { kind: 'comments', severity: 'action', label: '9 new comments', count: 9 },
              { kind: 'attachments', severity: 'action', label: '4 new attachments', count: 4 }
            ]
          })
        ]}
        {...noopHandlers}
      />
    )
    for (const id of ['metric-comments', 'metric-attachments']) {
      const el = screen.getByTestId(id)
      expect(el.className).toContain('text-defect')
      expect(el.className).not.toContain('text-danger')
    }
  })

  it('shows a muted zero total for a ticketed case with nothing to report — it is a Jira fact, not a state', () => {
    render(<CaseDashboard cases={[mkCase({ actionItems: [] })]} {...noopHandlers} />)
    const metric = screen.getByTestId('metric-comments')
    expect(metric.textContent).toBe('0')
    expect(metric.className).toContain('text-mute')
  })

  it('omits the metrics entirely for a case with no jira ticket — there is no Jira fact to show', () => {
    render(<CaseDashboard cases={[mkCase({ jiraKey: null, actionItems: [] })]} {...noopHandlers} />)
    expect(screen.queryByTestId('metric-comments')).toBeNull()
    expect(screen.queryByTestId('metric-attachments')).toBeNull()
  })

  it('keeps non-numeric action items as chips', () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({
            actionItems: [
              { kind: 'sync-error', severity: 'action', label: 'sync failed — auth' },
              { kind: 'status', severity: 'action', label: 'status → In Review' }
            ]
          })
        ]}
        {...noopHandlers}
      />
    )
    expect(screen.getByText('sync failed — auth')).toBeInTheDocument()
    expect(screen.getByText('status → In Review')).toBeInTheDocument()
  })

  it('reserves the action slots so hovering never reflows the footer', () => {
    render(<CaseDashboard cases={[mkCase()]} {...noopHandlers} />)
    const slots = screen.getByTestId('card-actions')
    expect(slots.className).toContain('w-[52px]')
    expect(screen.getByLabelText('Export NAV-1')).toBeInTheDocument()
    expect(screen.getByLabelText('Delete NAV-1')).toBeInTheDocument()
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
    expect(screen.getByTestId('sync-badge').textContent).toBe('2d ago')
  })

  it('says "synced today" for a case synced within the day', () => {
    render(
      <CaseDashboard
        cases={[mkCase({ jiraSyncedAt: new Date().toISOString() })]}
        {...noopHandlers}
      />
    )
    expect(screen.getByTestId('sync-badge').textContent).toBe('today')
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
    // Asserted per-slot rather than by counting /9d ago/ matches across the card: the context
    // line renders an `updated Nd ago` of its own, and an unanchored match claimed it as a
    // second "recency" whenever that N ended in 9 — which, off a hardcoded `updatedAt`, meant
    // one calendar date in ten.
    expect(screen.getByTestId('sync-badge').textContent).toBe('9d ago')
    // The chip row is where the repeat would appear, and it is absent entirely: `stale` is the
    // only item here, and the card drops it because the footer already states the fact.
    expect(screen.queryByTestId('action-items')).not.toBeInTheDocument()
    expect(screen.queryByText('synced 9d ago')).not.toBeInTheDocument()
  })

  it('shows the jira priority', () => {
    render(<CaseDashboard cases={[mkCase({ jiraPriority: 'High' })]} {...noopHandlers} />)
    // A glyph now, so the priority name survives only as the accessible name.
    expect(screen.getByLabelText('Priority: High')).toBeInTheDocument()
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
          mkCase({ slug: 'done', status: 'closed', resolution: 'solved', phase: 'closed' })
        ]}
        {...noopHandlers}
      />
    )
    expect(screen.queryByText('done')).not.toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Show closed cases'))
    expect(screen.getByText('done')).toBeInTheDocument()
  })

  it('counts cases by phase in the eyebrow', () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({ slug: 'A', phase: 'analyzing' }),
          mkCase({ slug: 'B', phase: 'pr-created' }),
          mkCase({ slug: 'C', phase: 'pr-created' })
        ]}
        {...noopHandlers}
      />
    )
    expect(screen.getByText(/1 Analyzing · 2 PR created/)).toBeInTheDocument()
  })

  it('filters by phase', async () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({ slug: 'A', phase: 'analyzing' }),
          mkCase({ slug: 'B', phase: 'reviewing' })
        ]}
        {...noopHandlers}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /Status/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reviewing' }))
    expect(screen.queryByText('A')).not.toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
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
    await userEvent.type(screen.getByPlaceholderText('Search cases…'), 'PROJ-9')
    expect(screen.queryByText('alpha')).not.toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
  })

  it('shows counts by phase', () => {
    render(
      <CaseDashboard
        cases={[mkCase({ slug: 'a', phase: 'open' }), mkCase({ slug: 'b', phase: 'analyzing' })]}
        {...noopHandlers}
      />
    )
    expect(screen.getByText(/1 Open · 1 Analyzing/)).toBeInTheDocument()
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

  it('shows a recognised Jira priority as a severity-coloured glyph, not as text', () => {
    render(<CaseDashboard cases={[mkCase({ jiraPriority: 'High' })]} {...noopHandlers} />)
    const icon = screen.getByTestId('priority-icon')
    expect(icon.className).toContain('text-danger')
    expect(screen.queryByText('High')).toBeNull()
  })

  // Priority schemes are per-project, so an unmapped value has to degrade to the word rather
  // than to nothing — dropping it would silently lose the only priority signal on the card.
  it('falls back to the text chip for a priority scheme it does not recognise', () => {
    render(<CaseDashboard cases={[mkCase({ jiraPriority: 'Escalated' })]} {...noopHandlers} />)
    expect(screen.queryByTestId('priority-icon')).toBeNull()
    expect(screen.getByText('Escalated')).toBeInTheDocument()
  })

  it('omits the pill entirely when the case has no priority', () => {
    render(<CaseDashboard cases={[mkCase({ jiraPriority: null })]} {...noopHandlers} />)
    expect(screen.queryByText(/^(Highest|High|Medium|Low|Lowest)$/)).toBeNull()
  })

  it('pairs the status word with a glowing dot', () => {
    render(<CaseDashboard cases={[mkCase({ phase: 'analyzing' })]} {...noopHandlers} />)
    expect(screen.getByText('Analyzing')).toBeTruthy()
    expect(screen.getAllByTestId('status-dot').length).toBeGreaterThan(0)
  })

  it('gives the status dot and its word the same text-* colour class — they can never disagree', () => {
    render(<CaseDashboard cases={[mkCase({ phase: 'analyzing' })]} {...noopHandlers} />)
    const dot = screen.getByTestId('status-dot')
    const dotColorClass = dot.className.split(' ').find((cls) => cls.startsWith('text-'))
    expect(dotColorClass).toBeTruthy()
    const word = screen.getByText('Analyzing')
    expect(word.classList.contains(dotColorClass as string)).toBe(true)
  })

  it('spells out the rca-drafted phase', () => {
    render(<CaseDashboard cases={[mkCase({ phase: 'rca-drafted' })]} {...noopHandlers} />)
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

  it('puts the counts below the greeting, not above it', () => {
    render(<CaseDashboard cases={[mkCase({ status: 'open' })]} {...noopHandlers} />)
    const heading = screen.getByRole('heading', { name: /^Good (morning|afternoon|evening)$/ })
    const counts = screen.getByText(/1 Open/)
    // Node.compareDocumentPosition: 4 = "counts follows heading in document order"
    expect(heading.compareDocumentPosition(counts) & 4).toBeTruthy()
  })
})
