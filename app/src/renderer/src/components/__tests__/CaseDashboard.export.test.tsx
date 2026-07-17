// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { CaseDashboard } from '../CaseDashboard'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseRecord } from '../../../../shared/types'

const cases: CaseRecord[] = [
  {
    id: 1,
    slug: 'NAV-100',
    title: 'Tile region fails',
    jiraKey: null,
    jiraSyncedAt: null,
    status: 'open',
    resolution: null,
    tags: [],
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z'
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
  ;(window as unknown as { argus: unknown }).argus = {
    bundle: {
      export: vi.fn().mockResolvedValue({ ok: true, path: 'C:/x.arguscase', fileCount: 12 })
    },
    settings: { get: vi.fn(async () => payload()), onChanged: vi.fn(() => () => {}) },
    proposals: { list: vi.fn().mockResolvedValue({ proposals: [] }) }
  }
  settingsStore.reset()
})

describe('CaseDashboard export button', () => {
  it('exports with transcripts, does not open the case, shows the result note', async () => {
    const onOpen = vi.fn()
    render(
      <CaseDashboard
        cases={cases}
        onOpen={onOpen}
        onNew={() => undefined}
        onImport={() => undefined}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Export NAV-100' }))
    await waitFor(() =>
      expect(
        (window as unknown as { argus: { bundle: { export: ReturnType<typeof vi.fn> } } }).argus
          .bundle.export
      ).toHaveBeenCalledWith('NAV-100', true)
    )
    expect(onOpen).not.toHaveBeenCalled() // stopPropagation — the card click opens the case
    expect(await screen.findByText('exported 12 files')).toBeInTheDocument()
  })

  it('surfaces an export failure in the card footer', async () => {
    ;(
      window as unknown as { argus: { bundle: { export: ReturnType<typeof vi.fn> } } }
    ).argus.bundle.export.mockResolvedValue({ ok: false, error: 'disk full' })
    render(
      <CaseDashboard
        cases={cases}
        onOpen={() => undefined}
        onNew={() => undefined}
        onImport={() => undefined}
        onDeleted={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Export NAV-100' }))
    expect(await screen.findByText('disk full')).toBeInTheDocument()
  })
})
