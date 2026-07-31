// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseDashboard } from '../CaseDashboard'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseRecord } from '../../../../shared/types'
import { DEFAULT_MODE } from '../../../../shared/modes'

const cases: CaseRecord[] = [
  {
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

beforeEach(() => {
  window.argus = {
    settings: { get: vi.fn(async () => payload()), onChanged: vi.fn(() => () => {}) },
    proposals: { list: vi.fn().mockResolvedValue({ proposals: [] }) },
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
})

describe('CaseDashboard', () => {
  it('renders case cards with status chip and opens on click', () => {
    const onOpen = vi.fn()
    render(
      <CaseDashboard
        cases={cases}
        onOpen={onOpen}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('Bearing jumps'))
    expect(onOpen).toHaveBeenCalledWith('NAV-1')
    expect(screen.getByText('Analyzing')).toBeTruthy()
  })

  it('New case card opens the dialog via onNew', () => {
    const onNew = vi.fn()
    render(
      <CaseDashboard
        cases={[]}
        onOpen={vi.fn()}
        onNew={onNew}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /new case/i }))
    expect(onNew).toHaveBeenCalled()
  })

  it('Import case button calls onImport', () => {
    const onImport = vi.fn()
    render(
      <CaseDashboard
        cases={[]}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={onImport}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /import case/i }))
    expect(onImport).toHaveBeenCalled()
  })

  it('shows the resolution alongside a closed status', () => {
    const closedCases: CaseRecord[] = [{ ...cases[0], status: 'closed', resolution: 'wont-fix' }]
    render(
      <CaseDashboard
        cases={closedCases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    // hide-closed defaults to on — reveal the closed case first
    fireEvent.click(screen.getByLabelText('Show closed cases'))
    expect(screen.getByText('Closed · wont-fix')).toBeTruthy()
  })

  it('New and Import actions share one tile', () => {
    render(
      <CaseDashboard
        cases={[]}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    const newBtn = screen.getByRole('button', { name: /new case/i })
    const importBtn = screen.getByRole('button', { name: /import case/i })
    expect(newBtn.parentElement).toBe(importBtn.parentElement)
  })

  const twoCases: CaseRecord[] = [
    {
      ...cases[0],
      slug: 'NAV-1',
      title: 'Bearing jumps',
      status: 'analyzing',
      jiraPriority: 'High'
    },
    {
      ...cases[0],
      id: 2,
      slug: 'NAV-2',
      title: 'Route missing',
      status: 'open',
      jiraPriority: 'Low'
    }
  ]

  it('filters by status', () => {
    render(
      <CaseDashboard
        cases={twoCases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /status/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }))
    expect(screen.queryByText('Bearing jumps')).toBeNull()
    expect(screen.getByText('Route missing')).toBeTruthy()
  })

  it('filters by priority, offering only the values actually present', () => {
    render(
      <CaseDashboard
        cases={twoCases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /priority/i }))
    expect(screen.queryByRole('menuitem', { name: 'Medium' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))
    expect(screen.getByText('Bearing jumps')).toBeTruthy()
    expect(screen.queryByText('Route missing')).toBeNull()
  })

  it('an explicit Closed filter overrides the hide-closed default', () => {
    const withClosed = [
      ...twoCases,
      { ...cases[0], id: 3, slug: 'NAV-3', title: 'Old bug', status: 'closed' as const }
    ]
    render(
      <CaseDashboard
        cases={withClosed}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    expect(screen.queryByText('Old bug')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /status/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Closed' }))
    expect(screen.getByText('Old bug')).toBeTruthy()
  })

  it('the trigger names the active filter', () => {
    render(
      <CaseDashboard
        cases={twoCases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /status/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }))
    expect(screen.getByRole('button', { name: /status: open/i })).toBeTruthy()
  })
})
