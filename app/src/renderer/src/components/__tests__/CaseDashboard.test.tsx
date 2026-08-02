// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseDashboard } from '../CaseDashboard'
import { settingsStore } from '../../lib/settingsStore'
import { resetGithubIdentity } from '../../lib/githubIdentity'
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
    status: 'open',
    resolution: null,
    phase: 'analyzing',
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
  // The login is memoised for the renderer's lifetime, which in a test file means "for the whole
  // file" — without this the first case to resolve it decides the greeting for every later one.
  resetGithubIdentity()
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
    const closedCases: CaseRecord[] = [
      { ...cases[0], status: 'closed', resolution: 'wont-fix', phase: 'closed' }
    ]
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

  describe('greeting', () => {
    function renderHome(): void {
      render(
        <CaseDashboard
          cases={[]}
          onOpen={vi.fn()}
          onNew={vi.fn()}
          onImport={vi.fn()}
          onDeleted={vi.fn()}
        />
      )
    }

    it('greets by time of day and addresses the gh user', async () => {
      window.argus.sourceControl = {
        status: vi.fn().mockResolvedValue({ authenticated: true, login: 'octocat' })
      } as never
      renderHome()
      const heading = await screen.findByRole('heading', {
        name: /^Good (morning|afternoon|evening), octocat$/
      })
      expect(heading).toBeTruthy()
    })

    // gh is optional: not installed, not logged in, or an IPC failure must all leave a usable
    // masthead rather than an empty one or a thrown render.
    it('falls back to the bare greeting when there is no gh login', async () => {
      window.argus.sourceControl = {
        status: vi.fn().mockResolvedValue({ authenticated: false, login: null })
      } as never
      renderHome()
      expect(
        await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening)$/ })
      ).toBeTruthy()
    })

    it('no longer prints the wordmark — that moved to the top bar', () => {
      renderHome()
      expect(screen.queryByText('ARGUS')).toBeNull()
    })
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
      status: 'open',
      phase: 'analyzing',
      jiraPriority: 'High'
    },
    {
      ...cases[0],
      id: 2,
      slug: 'NAV-2',
      title: 'Route missing',
      status: 'open',
      phase: 'open',
      jiraPriority: 'Low'
    }
  ]

  it('filters by phase', () => {
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

  it('narrows by status AND priority together, not just one filter at a time', () => {
    const threeCases: CaseRecord[] = [
      ...twoCases,
      {
        ...cases[0],
        id: 3,
        slug: 'NAV-3',
        title: 'Signal drop',
        status: 'open',
        phase: 'open',
        jiraPriority: 'High'
      }
    ]
    render(
      <CaseDashboard
        cases={threeCases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /status/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }))
    fireEvent.click(screen.getByRole('button', { name: /priority/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))
    // NAV-1 is High but analyzing (wrong status); NAV-2 is open but Low (wrong priority);
    // only NAV-3 satisfies both at once.
    expect(screen.getByText('Signal drop')).toBeTruthy()
    expect(screen.queryByText('Bearing jumps')).toBeNull()
    expect(screen.queryByText('Route missing')).toBeNull()
  })

  it('an explicit Closed filter overrides the hide-closed default', () => {
    const withClosed = [
      ...twoCases,
      {
        ...cases[0],
        id: 3,
        slug: 'NAV-3',
        title: 'Old bug',
        status: 'closed' as const,
        phase: 'closed' as const
      }
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
