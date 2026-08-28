// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CaseDashboard } from '../CaseDashboard'
import { settingsStore } from '../../lib/settingsStore'
import { routinesStore } from '../../lib/routinesStore'
import { resetGithubIdentity } from '../../lib/githubIdentity'
import { uiStore } from '../../lib/uiStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseRecord } from '../../../../shared/types'
import { DEFAULT_MODE } from '../../../../shared/modes'

function mk(slug: string, updatedAt: string, lastWorkedAt: string | null): CaseRecord {
  return {
    id: 1,
    slug,
    origin: 'user',
    reviewState: null,
    title: slug,
    jiraKey: null,
    ticketProvider: 'jira',
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
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt,
    actionItems: [],
    lastWorkedAt,
    archivedAt: null,
    archivePath: null,
    lastOpenedAt: null
  }
}

const D = (day: number): string => `2026-08-0${day}T00:00:00.000Z`

// Deliberately crossed: WORKED order is A,B,C and UPDATED order is C,B,A, so no assertion below
// can pass by reading the wrong field — or by leaving the list in the order it was handed.
const cases = [mk('A', D(1), D(3)), mk('B', D(2), D(2)), mk('C', D(3), D(1))]

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
    proposals: {
      list: vi.fn().mockResolvedValue({ proposals: [] }),
      onChanged: vi.fn(() => () => {})
    },
    pr: {
      statusList: vi.fn(async () => ({})),
      statusRefresh: vi.fn(async () => ({})),
      onStatusChanged: vi.fn(() => () => {})
    },
    jira: {
      syncAll: vi.fn().mockResolvedValue({ ok: true, value: { synced: 0, changed: 0, failed: 0 } }),
      onSyncProgress: vi.fn(() => () => {})
    },
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
  resetGithubIdentity()
  // uiStore is a module singleton whose state is NOT rebuilt from localStorage per test —
  // clearing storage would leave the previous test's selection in memory and silently decide
  // this one's ordering. Reset the state itself, before and after.
  uiStore.setCaseSort('triage', 'desc')
})

afterEach(() => {
  uiStore.setCaseSort('triage', 'desc')
})

function mount(): void {
  render(
    <CaseDashboard
      cases={cases}
      onOpen={vi.fn()}
      onNew={vi.fn()}
      onImport={vi.fn()}
      onDeleted={vi.fn()}
    />
  )
}

const order = (): string[] => screen.getAllByTestId('case-title').map((e) => e.textContent ?? '')

/** Open the Sort dropdown and pick a row by its label. */
function pickSort(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: /sort cases by/i }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

describe('CaseDashboard sort control', () => {
  it('defaults to triage — the order main handed down, untouched', () => {
    mount()
    expect(order()).toEqual(['A', 'B', 'C'])
    // No direction toggle under triage: that ordering has no direction to flip.
    expect(screen.queryByRole('button', { name: /sort direction/i })).toBeNull()
  })

  it('sorts by recently worked on, and flips on the direction toggle', () => {
    mount()
    pickSort('Recently worked on')
    expect(order()).toEqual(['A', 'B', 'C'])

    fireEvent.click(screen.getByRole('button', { name: /sort direction/i }))
    expect(order()).toEqual(['C', 'B', 'A'])
  })

  it('sorts by updated, which is a different field from recently worked on', () => {
    mount()
    pickSort('Updated')
    expect(order()).toEqual(['C', 'B', 'A'])

    fireEvent.click(screen.getByRole('button', { name: /sort direction/i }))
    expect(order()).toEqual(['A', 'B', 'C'])
  })

  it('keeps the direction when the field changes', () => {
    mount()
    pickSort('Updated')
    fireEvent.click(screen.getByRole('button', { name: /sort direction/i }))
    expect(order()).toEqual(['A', 'B', 'C']) // updated, oldest first

    pickSort('Recently worked on')
    // Still oldest-first — switching field must not silently reverse the list.
    expect(order()).toEqual(['C', 'B', 'A'])
  })

  it('names the active field in the trigger', () => {
    mount()
    expect(screen.getByRole('button', { name: /sort cases by/i }).textContent).toContain('Sort')
    pickSort('Recently worked on')
    expect(screen.getByRole('button', { name: /sort cases by/i }).textContent).toContain(
      'Sort: Recently worked on'
    )
  })

  it('persists the selection through a remount', () => {
    const { unmount } = render(
      <CaseDashboard
        cases={cases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    pickSort('Updated')
    expect(localStorage.getItem('argus.ui.caseSort')).toBe('updated')
    unmount()

    mount()
    expect(order()).toEqual(['C', 'B', 'A'])
  })
})
