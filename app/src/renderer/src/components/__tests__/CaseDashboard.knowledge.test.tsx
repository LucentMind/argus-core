// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { CaseDashboard } from '../CaseDashboard'
import { settingsStore } from '../../lib/settingsStore'
import { routinesStore } from '../../lib/routinesStore'
import { proposalsStore } from '../../lib/proposalsStore'
import type { ProposalCounts } from '../../../../shared/proposals'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseRecord } from '../../../../shared/types'
import { DEFAULT_MODE } from '../../../../shared/modes'

const cases: CaseRecord[] = [
  {
    id: 1,
    slug: 'NAV-1',
    origin: 'user',
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

// copied from CaseDashboard.test.tsx (no exported defaultProps there — props are
// inlined per-test), so we reconstruct the minimal signature-matching props here.
const defaultProps = {
  cases,
  onOpen: vi.fn(),
  onNew: vi.fn(),
  onImport: vi.fn(),
  onDeleted: vi.fn()
}

let onChangedCb: ((c: ProposalCounts) => void) | null = null

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
    },

    // The dashboard now also mounts RoutineInbox unconditionally; an empty payload keeps it
    // hidden so this file's assertions (none of which are about routines) are unaffected.
    routines: {
      list: vi.fn().mockResolvedValue({
        routines: [],
        loadError: null,
        runningId: null,
        queued: [],
        nextRunAt: {},
        unreviewedCount: 0,
        runs: []
      }),
      onChanged: vi.fn(() => () => {}),
      markReviewed: vi.fn(),
      markAllReviewed: vi.fn()
    }
  } as never
  settingsStore.reset()
  routinesStore.reset()
  proposalsStore.reset()
  onChangedCb = null
  ;(window as never as { argus: Record<string, unknown> }).argus.proposals = {
    list: vi.fn().mockResolvedValue({
      proposals: [
        { file: 'a.md', type: 'recipe' },
        { file: 'b.md', type: 'recipe' }
      ]
    }),
    onChanged: vi.fn((cb: (c: ProposalCounts) => void) => {
      onChangedCb = cb
      return () => {}
    })
  }
})

describe('knowledge pending line', () => {
  it('shows the pending count when > 0', async () => {
    render(<CaseDashboard {...defaultProps} />)
    expect(await screen.findByText(/Knowledge review pending: 2/)).toBeInTheDocument()
  })

  it('updates live when the proposals store broadcasts a change', async () => {
    render(<CaseDashboard {...defaultProps} />)
    expect(await screen.findByText(/Knowledge review pending: 2/)).toBeInTheDocument()

    act(() => {
      onChangedCb?.({ pendingCount: 5, byType: { recipe: 5 } })
    })
    expect(await screen.findByText(/Knowledge review pending: 5/)).toBeInTheDocument()

    act(() => {
      onChangedCb?.({ pendingCount: 0, byType: {} })
    })
    await waitFor(() =>
      expect(screen.queryByText(/Knowledge review pending/)).not.toBeInTheDocument()
    )
  })

  it('hides when 0', async () => {
    ;(
      window as never as { argus: { proposals: { list: ReturnType<typeof vi.fn> } } }
    ).argus.proposals.list.mockResolvedValue({ proposals: [] })
    render(<CaseDashboard {...defaultProps} />)
    await waitFor(() =>
      expect(screen.queryByText(/Knowledge review pending/)).not.toBeInTheDocument()
    )
  })
})
