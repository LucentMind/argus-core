// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
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
    jiraKey: 'NAV-1',
    jiraSyncedAt: null,
    jiraDeselected: [],
    status: 'analyzing',
    resolution: null,
    tags: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z'
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
    proposals: { list: vi.fn().mockResolvedValue({ proposals: [] }) }
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
    expect(screen.getByText('analyzing')).toBeTruthy()
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
    expect(screen.getByText('closed · wont-fix')).toBeTruthy()
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
})
