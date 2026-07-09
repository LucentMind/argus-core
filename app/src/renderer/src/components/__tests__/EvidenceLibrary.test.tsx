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

  it('renders derived rows with a chip and an Analyze suggestion for binary types', async () => {
    window.argus.evidence.list = vi.fn(async () => [
      { id: 1, caseId: 1, relPath: 'evidence/trace.binlog', sha256: 'x', artifactType: 'binlog',
        size: 10, origin: 'upload', meta: {}, createdAt: '2026-07-09' },
      { id: 2, caseId: 1, relPath: 'evidence/.derived/trace.binlog.txt', sha256: 'y', artifactType: 'text',
        size: 5, origin: 'agent', meta: { derivedFrom: 1 }, createdAt: '2026-07-09' }
    ]) as never
    const onSuggest = vi.fn()
    render(<EvidenceLibrary caseSlug="NAV-1" onSuggest={onSuggest} />)
    expect(await screen.findByText('derived')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /analyze/i }))
    expect(onSuggest).toHaveBeenCalledWith('/analyze-binlog evidence/trace.binlog')
  })

  it('filters by artifact type', async () => {
    render(<EvidenceLibrary caseSlug="NAVAPI-1" />)
    await waitFor(() => expect(screen.getByText('evidence/log.txt')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('type-filter'), { target: { value: 'binlog' } })
    expect(screen.queryByText('evidence/log.txt')).toBeNull()
    expect(screen.getByText('evidence/trace.binlog')).toBeTruthy()
  })
})
