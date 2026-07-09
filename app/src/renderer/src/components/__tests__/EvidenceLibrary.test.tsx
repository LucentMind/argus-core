// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EvidenceLibrary } from '../EvidenceLibrary'
import type { EvidenceRecord } from '../../../../shared/types'

const rows: EvidenceRecord[] = [
  {
    id: 1, caseId: 1, relPath: 'evidence/log.txt', sha256: 'a'.repeat(64), artifactType: 'applog',
    size: 120, origin: 'upload', meta: {}, createdAt: '2026-07-09T00:00:00Z'
  },
  {
    id: 2, caseId: 1, relPath: 'evidence/trace.binlog', sha256: 'b'.repeat(64), artifactType: 'binlog',
    size: 999, origin: 'upload', meta: {}, createdAt: '2026-07-09T00:00:00Z'
  }
]

beforeEach(() => {
  vi.stubGlobal('argus', undefined) // ensure clean slate
  window.argus = {
    evidence: {
      list: vi.fn().mockResolvedValue(rows),
      ingest: vi.fn().mockResolvedValue([]),
      read: vi.fn()
    },
    cases: { create: vi.fn(), list: vi.fn() },
    search: { query: vi.fn() },
    pathForFile: vi.fn()
  } as unknown as typeof window.argus
})

describe('EvidenceLibrary', () => {
  it('lists evidence with type badges', async () => {
    render(<EvidenceLibrary caseSlug="NAVAPI-1" />)
    await waitFor(() => expect(screen.getByText('evidence/log.txt')).toBeTruthy())
    expect(screen.getByText('applog')).toBeTruthy()
    expect(screen.getByText('binlog')).toBeTruthy()
  })

  it('filters by artifact type', async () => {
    render(<EvidenceLibrary caseSlug="NAVAPI-1" />)
    await waitFor(() => expect(screen.getByText('evidence/log.txt')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('type-filter'), { target: { value: 'binlog' } })
    expect(screen.queryByText('evidence/log.txt')).toBeNull()
    expect(screen.getByText('evidence/trace.binlog')).toBeTruthy()
  })
})
