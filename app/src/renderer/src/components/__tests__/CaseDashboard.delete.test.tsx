// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseDashboard } from '../CaseDashboard'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseRecord } from '../../../../shared/types'

const cases: CaseRecord[] = [
  {
    id: 1,
    slug: 'NAV-1',
    title: 'Bearing jumps',
    jiraKey: null,
    jiraSyncedAt: null,
    status: 'open',
    tags: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z'
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
    bundle: { export: vi.fn() }
  } as never
  settingsStore.reset()
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

  it('deletes without the dialog when confirmCaseDelete is off', async () => {
    setup(payload((p) => (p.settings.general.confirmCaseDelete = false)))
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
    // settingsStore fetches async — wait until the payload has landed
    await waitFor(() => expect(settingsStore.get()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Delete NAV-1' }))
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('NAV-1'))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
  })
})
