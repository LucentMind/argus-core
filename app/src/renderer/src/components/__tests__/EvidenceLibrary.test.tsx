// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EvidenceLibrary } from '../EvidenceLibrary'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { EvidenceRecord } from '../../../../shared/types'

function payload(): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: {
      traceDir: { value: null, source: 'default' },
      parseBin: { value: null, source: 'default' }
    },
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: true },
    loadError: null
  }
}

const rows: EvidenceRecord[] = [
  {
    id: 1,
    caseId: 1,
    relPath: 'evidence/log.txt',
    sha256: 'a'.repeat(64),
    artifactType: 'applog',
    size: 120,
    origin: 'upload',
    meta: {},
    createdAt: '2026-07-09T00:00:00Z'
  },
  {
    id: 2,
    caseId: 1,
    relPath: 'evidence/trace.binlog',
    sha256: 'b'.repeat(64),
    artifactType: 'binlog',
    size: 999,
    origin: 'upload',
    meta: {},
    createdAt: '2026-07-09T00:00:00Z'
  }
]

beforeEach(() => {
  vi.stubGlobal('argus', undefined) // ensure clean slate
  // reset the shared settingsStore singleton so other test files' payloads
  // never leak into this one
  settingsStore.reset()
  window.argus = {
    evidence: {
      list: vi.fn().mockResolvedValue(rows),
      ingest: vi.fn().mockResolvedValue([]),
      read: vi.fn()
    },
    cases: { create: vi.fn(), list: vi.fn() },
    search: { query: vi.fn() },
    pathForFile: vi.fn(),
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async () => payload()),
      reveal: vi.fn(),
      onChanged: vi.fn(() => () => {})
    }
  } as unknown as typeof window.argus
})

describe('EvidenceLibrary', () => {
  it('lists evidence with stripped display names and type badges', async () => {
    render(<EvidenceLibrary caseSlug="NAVAPI-1" />)
    await waitFor(() => expect(screen.getByText('log.txt')).toBeTruthy())
    // the evidence/ storage prefix is display-stripped but kept in the hover title
    expect(screen.queryByText('evidence/log.txt')).toBeNull()
    expect(screen.getByText('log.txt').closest('[title]')?.getAttribute('title')).toBe(
      'evidence/log.txt'
    )
    expect(screen.getByText('applog')).toBeTruthy()
    expect(screen.getByText('binlog')).toBeTruthy()
  })

  it('shows size in MB and no added date', async () => {
    render(<EvidenceLibrary caseSlug="NAVAPI-1" />)
    await waitFor(() => expect(screen.getByText('log.txt')).toBeTruthy())
    // both fixture rows are far below 0.1 MB
    expect(screen.getAllByText('<0.1 MB')).toHaveLength(2)
    // no raw byte counts, no timestamp column
    expect(screen.queryByText(/\d+ B$/)).toBeNull()
    expect(screen.queryByText(/2026/)).toBeNull()
  })

  it('renders derived rows with a chip, stripped .derived/ prefix, and an Analyze suggestion', async () => {
    window.argus.evidence.list = vi.fn(async () => [
      {
        id: 1,
        caseId: 1,
        relPath: 'evidence/trace.binlog',
        sha256: 'x',
        artifactType: 'binlog',
        size: 10,
        origin: 'upload',
        meta: {},
        createdAt: '2026-07-09'
      },
      {
        id: 2,
        caseId: 1,
        relPath: 'evidence/.derived/trace.binlog.txt',
        sha256: 'y',
        artifactType: 'text',
        size: 5,
        origin: 'agent',
        meta: { derivedFrom: 1 },
        createdAt: '2026-07-09'
      }
    ]) as never
    const onSuggest = vi.fn()
    render(<EvidenceLibrary caseSlug="NAV-1" onSuggest={onSuggest} />)
    expect(await screen.findByText('derived')).toBeTruthy()
    // .derived/ storage prefix is display-stripped too
    expect(screen.getByText('trace.binlog.txt')).toBeTruthy()
    // Analyze still suggests the real (unstripped) relPath
    fireEvent.click(screen.getByRole('button', { name: /analyze/i }))
    expect(onSuggest).toHaveBeenCalledWith('/analyze-binlog evidence/trace.binlog')
  })

  it('filters by artifact type', async () => {
    render(<EvidenceLibrary caseSlug="NAVAPI-1" />)
    await waitFor(() => expect(screen.getByText('log.txt')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('type-filter'), { target: { value: 'binlog' } })
    expect(screen.queryByText('log.txt')).toBeNull()
    expect(screen.getByText('trace.binlog')).toBeTruthy()
  })
})
