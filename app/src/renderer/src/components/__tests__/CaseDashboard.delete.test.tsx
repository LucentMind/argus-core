// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseDashboard } from '../CaseDashboard'
import { settingsStore } from '../../lib/settingsStore'
import { routinesStore } from '../../lib/routinesStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseRecord } from '../../../../shared/types'
import { DEFAULT_MODE } from '../../../../shared/modes'

const cases: CaseRecord[] = [
  {
    id: 1,
    slug: 'NAV-1',
    origin: 'user',
    reviewState: null,
    title: 'Bearing jumps',
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
    phase: 'open',
    activeMode: DEFAULT_MODE,
    tags: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    actionItems: [],
    lastWorkedAt: null
  }
]

function payload(mut?: (p: SettingsPayload) => void): SettingsPayload {
  const p: SettingsPayload = {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
  mut?.(p)
  return p
}

let deleteMock: ReturnType<typeof vi.fn>

function setup(p: SettingsPayload): void {
  deleteMock = vi.fn(async () => undefined)
  window.argus = {
    cases: { delete: deleteMock },
    settings: { get: vi.fn(async () => p), onChanged: vi.fn(() => () => {}) },
    bundle: { export: vi.fn() },
    proposals: {
      list: vi.fn().mockResolvedValue({ proposals: [] }),
      onChanged: vi.fn(() => () => {})
    },
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
}

describe('CaseDashboard delete', () => {
  beforeEach(() => setup(payload()))

  it('opens the confirm dialog; Delete stays disabled until the exact slug is typed', async () => {
    const onDeleted = vi.fn()
    render(
      <CaseDashboard
        cases={cases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={onDeleted}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete NAV-1' }))
    const confirmBtn = await screen.findByRole('button', { name: 'Delete case' })
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Confirm slug'), { target: { value: 'NAV-2' } })
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Confirm slug'), { target: { value: 'NAV-1' } })
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('NAV-1'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
  })

  it('Cancel closes the dialog without deleting', async () => {
    render(
      <CaseDashboard
        cases={cases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete NAV-1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('Escape closes the dialog without deleting, regardless of focus', async () => {
    render(
      <CaseDashboard
        cases={cases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete NAV-1' }))
    await screen.findByRole('dialog')
    // move focus off the slug input — Escape must still close the dialog
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('shows the error and re-enables Delete when the delete call fails', async () => {
    const onDeleted = vi.fn()
    render(
      <CaseDashboard
        cases={cases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={onDeleted}
      />
    )
    deleteMock.mockImplementation(async () => {
      throw new Error('locked file')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Delete NAV-1' }))
    fireEvent.change(await screen.findByLabelText('Confirm slug'), {
      target: { value: 'NAV-1' }
    })
    const confirmBtn = screen.getByRole('button', { name: 'Delete case' })
    fireEvent.click(confirmBtn)
    expect(await screen.findByText('locked file')).toBeTruthy()
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false) // not busy — retry possible
    expect(onDeleted).not.toHaveBeenCalled()
  })

  // The `general.confirmCaseDelete` escape hatch is gone (user-directed, 2026-08-21): a case
  // delete is irreversible, so the dialog is the only path. These two used to cover the
  // confirm-off shortcut and now assert it no longer exists.
  it('always opens the dialog — there is no confirm-off shortcut', async () => {
    setup(payload())
    render(
      <CaseDashboard
        cases={cases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete NAV-1' }))
    expect(await screen.findByLabelText('Confirm slug')).toBeTruthy()
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('opens the dialog even with a legacy confirmCaseDelete:false on disk', async () => {
    setup(payload((p) => (p.settings.general.confirmCaseDelete = false)))
    render(
      <CaseDashboard
        cases={cases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete NAV-1' }))
    expect(await screen.findByLabelText('Confirm slug')).toBeTruthy()
    expect(deleteMock).not.toHaveBeenCalled()
  })
})
