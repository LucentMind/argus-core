// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { CaseDashboard } from '../CaseDashboard'
import { settingsStore } from '../../lib/settingsStore'
import { routinesStore } from '../../lib/routinesStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseRecord } from '../../../../shared/types'
import { DEFAULT_MODE } from '../../../../shared/modes'
import type { RoutineDef, RoutineRunSummary, RoutinesPayload } from '../../../../shared/routines'

const cases: CaseRecord[] = [
  {
    id: 1,
    slug: 'NAV-1',
    origin: 'routine',
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
    updatedAt: '2026-07-08T00:00:00Z',
    actionItems: []
  }
]

function payload(): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

const sweep: RoutineDef = {
  id: 'sweep',
  name: 'Nightly sweep',
  prompt: 'Sweep the repo',
  timeoutMs: 600_000,
  enabled: true
}

function run(over: Partial<RoutineRunSummary> = {}): RoutineRunSummary {
  return {
    id: 1,
    routineId: 'sweep',
    caseSlug: 'NAV-1',
    sessionId: 7,
    trigger: 'scheduled',
    status: 'ok',
    startedAt: '2026-08-03T02:00:00.000Z',
    finishedAt: '2026-08-03T02:05:00.000Z',
    summary: 'nothing new',
    error: null,
    reviewedAt: null,
    ...over
  }
}

function routinesPayload(over: Partial<RoutinesPayload> = {}): RoutinesPayload {
  return {
    routines: [sweep],
    loadError: null,
    runningId: null,
    queued: [],
    nextRunAt: {},
    unreviewedCount: 1,
    runs: [run()],
    ...over
  }
}

// copied from CaseDashboard.test.tsx (no exported defaultProps there — props are
// inlined per-test), so we reconstruct the minimal signature-matching props here.
const defaultProps = {
  cases,
  onOpen: vi.fn(),
  onNew: vi.fn(),
  onImport: vi.fn(),
  onDeleted: vi.fn()
}

beforeEach(() => {
  window.argus = {
    settings: { get: vi.fn(async () => payload()), onChanged: vi.fn(() => () => {}) },
    // The dashboard mounts usePrStatuses for every case, which reads the cache and
    // subscribes through these on mount.
    pr: {
      statusList: vi.fn(async () => ({})),
      statusRefresh: vi.fn(async () => ({})),
      onStatusChanged: vi.fn(() => () => {})
    },

    jira: {
      syncAll: vi.fn().mockResolvedValue({ ok: true, value: { synced: 0, changed: 0, failed: 0 } }),
      onSyncProgress: vi.fn(() => () => {})
    }
  } as never
  settingsStore.reset()
  routinesStore.reset()
  ;(window as never as { argus: Record<string, unknown> }).argus.proposals = {
    list: vi.fn().mockResolvedValue({ proposals: [] })
  }
  ;(window as never as { argus: Record<string, unknown> }).argus.routines = {
    list: vi.fn().mockResolvedValue(routinesPayload()),
    onChanged: vi.fn(() => () => {}),
    markReviewed: vi.fn(),
    markAllReviewed: vi.fn()
  }
})

describe('routine inbox on Home', () => {
  it('renders above the case grid when runs are unreviewed', async () => {
    render(<CaseDashboard {...defaultProps} />)
    const inbox = await screen.findByTestId('routine-inbox')
    const firstCard = screen.getByTestId('case-title')
    // Placement is the point of this increment, so assert it rather than mere presence.
    // DOCUMENT_POSITION_FOLLOWING means the argument comes after the node it is called on.
    expect(inbox.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders nothing when there is nothing to review', async () => {
    ;(
      window as never as { argus: { routines: { list: ReturnType<typeof vi.fn> } } }
    ).argus.routines.list.mockResolvedValue(routinesPayload({ unreviewedCount: 0, runs: [] }))
    render(<CaseDashboard {...defaultProps} />)
    await waitFor(() => expect(screen.queryByTestId('routine-inbox')).not.toBeInTheDocument())
  })
})

describe('per-case review tally on the case card', () => {
  it('counts only unreviewed, non-running runs for THIS case, ignoring other cases', async () => {
    ;(
      window as never as { argus: { routines: { list: ReturnType<typeof vi.fn> } } }
    ).argus.routines.list.mockResolvedValue(
      routinesPayload({
        // Deliberately wrong relative to the per-case answer below (2), so a regression that
        // swaps in the global unreviewedCount fails loudly instead of coincidentally passing.
        unreviewedCount: 99,
        runs: [
          run({ id: 1, status: 'ok', reviewedAt: null }), // counted
          run({ id: 2, status: 'ok', reviewedAt: null }), // counted
          run({ id: 3, status: 'ok', reviewedAt: '2026-08-03T03:00:00.000Z' }), // reviewed — excluded
          run({ id: 4, status: 'running', reviewedAt: null }), // running — excluded
          run({ id: 5, caseSlug: 'OTHER-1', status: 'ok', reviewedAt: null }) // different case — excluded
        ]
      })
    )
    render(<CaseDashboard {...defaultProps} />)
    expect(await screen.findByTestId('case-review-count')).toHaveTextContent('2 to review')
  })
})
