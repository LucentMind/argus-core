// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FindingsPane } from '../FindingsPane'
import { findingsStore } from '../../lib/findingsStore'
import type { FindingRow } from '../../../../shared/observability'

function row(over: Partial<FindingRow>): FindingRow {
  return {
    id: 1,
    caseId: 1,
    sessionId: 1,
    turnId: null,
    summary: 's',
    reviewState: 'pending',
    reviewedAt: null,
    createdAt: '2026-07-27T10:00:00.000Z',
    layer: null,
    severity: null,
    diffPath: null,
    diffLine: null,
    suggestedChange: null,
    commentUrl: null,
    pushedSha: null,
    commentBody: null,
    headSha: null,
    mode: 'investigation',
    role: null,
    status: 'confirmed',
    roleSource: null,
    causedBy: null,
    supersededBy: null,
    reviewReason: null,
    reviewActor: null,
    rejectTag: null,
    rejectNote: null,
    ...over
  }
}

const list = vi.fn()

beforeEach(() => {
  findingsStore.clearForTests()
  list.mockReset()
  window.argus = {
    findings: { list, review: vi.fn(), clear: vi.fn() },
    cases: { readFindings: vi.fn().mockResolvedValue('') },
    review: { worktreeHead: vi.fn().mockResolvedValue(null) },
    rca: { onRcaChanged: vi.fn(() => () => {}) }
  } as never // test double for the preload bridge
})

describe('retracted finding card', () => {
  it('labels an agent retraction and shows its reason', async () => {
    list.mockResolvedValue([
      row({
        id: 4,
        summary: 'Race in parser',
        reviewState: 'rejected',
        reviewActor: 'agent',
        reviewReason: 'the guard is in the caller'
      })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    // A rejected finding is ruled out: it lives in the collapsed RULED OUT section.
    await userEvent.click(await screen.findByRole('button', { name: 'RULED OUT · 1' }))
    expect(await screen.findByText('retracted by agent')).toBeInTheDocument()
    expect(screen.getByText('the guard is in the caller')).toBeInTheDocument()
  })

  it('shows neither for a human reject', async () => {
    list.mockResolvedValue([
      row({ id: 5, summary: 'Race', reviewState: 'rejected', reviewActor: 'human' })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    // A rejected finding is ruled out: it lives in the collapsed RULED OUT section.
    await userEvent.click(await screen.findByRole('button', { name: 'RULED OUT · 1' }))
    await waitFor(() => expect(screen.getByText('Race')).toBeInTheDocument())
    expect(screen.queryByText('retracted by agent')).not.toBeInTheDocument()
  })

  it('shows neither for a legacy reject with a null actor', async () => {
    list.mockResolvedValue([
      row({ id: 6, summary: 'Legacy', reviewState: 'rejected', reviewActor: null })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    // A rejected finding is ruled out: it lives in the collapsed RULED OUT section.
    await userEvent.click(await screen.findByRole('button', { name: 'RULED OUT · 1' }))
    await waitFor(() => expect(screen.getByText('Legacy')).toBeInTheDocument())
    expect(screen.queryByText('retracted by agent')).not.toBeInTheDocument()
  })
})
