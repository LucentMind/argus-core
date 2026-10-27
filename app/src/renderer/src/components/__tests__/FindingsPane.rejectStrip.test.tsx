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
    summary: 'Race in parser',
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
    reviewReason: null,
    reviewActor: null,
    rejectTag: null,
    rejectNote: null,
    mode: 'investigation',
    role: null,
    status: 'confirmed',
    roleSource: null,
    causedBy: null,
    supersededBy: null,
    ...over
  }
}

const list = vi.fn()
const review = vi.fn()

beforeEach(() => {
  findingsStore.clearForTests()
  list.mockReset()
  review.mockReset()
  window.argus = {
    findings: { list, review, clear: vi.fn(), delete: vi.fn() },
    cases: { readFindings: vi.fn().mockResolvedValue('') },
    review: { worktreeHead: vi.fn().mockResolvedValue(null) },
    rca: { onRcaChanged: vi.fn(() => () => {}) }
  } as never
})

async function pane(initial: FindingRow): Promise<void> {
  list.mockResolvedValue([initial])
  render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
  await screen.findByText('Race in parser')
}

describe('FindingsPane reject strip', () => {
  it('thumbs-down rejects on the spot and opens the strip; a chip sends the tag', async () => {
    await pane(row({}))
    review.mockResolvedValueOnce({ id: 1, reviewState: 'rejected', reviewActor: 'human' })
    await userEvent.click(screen.getByRole('button', { name: /mark finding not useful/i }))
    expect(review).toHaveBeenCalledWith(1, 'rejected', undefined)
    const chip = await screen.findByRole('button', { name: 'Reject as wrong' })
    review.mockResolvedValueOnce({
      id: 1,
      reviewState: 'rejected',
      reviewActor: 'human',
      rejectTag: 'wrong'
    })
    await userEvent.click(chip)
    expect(review).toHaveBeenLastCalledWith(1, 'rejected', { tag: 'wrong' })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reject as wrong' })).not.toBeInTheDocument()
    )
    expect(screen.getByText('Wrong')).toBeInTheDocument()
  })
  it('a failed reason save (store returns null) keeps the strip open', async () => {
    await pane(row({}))
    review.mockResolvedValueOnce({ id: 1, reviewState: 'rejected', reviewActor: 'human' })
    await userEvent.click(screen.getByRole('button', { name: /mark finding not useful/i }))
    review.mockResolvedValueOnce(null)
    await userEvent.click(await screen.findByRole('button', { name: 'Reject as wrong' }))
    await waitFor(() => expect(review).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject as wrong' })).toBeInTheDocument()
  })
  it('Skip closes the strip with no call; the card then offers why?', async () => {
    await pane(row({}))
    review.mockResolvedValueOnce({ id: 1, reviewState: 'rejected', reviewActor: 'human' })
    await userEvent.click(screen.getByRole('button', { name: /mark finding not useful/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Skip' }))
    expect(review).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Add reject reason' }))
    expect(await screen.findByRole('button', { name: 'Reject as other' })).toBeInTheDocument()
  })
  it('toggling the finding back to pending closes the strip', async () => {
    list.mockResolvedValue([row({ reviewState: 'rejected', reviewActor: 'human' })])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    // A rejected finding is ruled out: it lives in the collapsed RULED OUT section.
    await userEvent.click(await screen.findByRole('button', { name: 'RULED OUT · 1' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add reject reason' }))
    expect(await screen.findByRole('button', { name: 'Skip' })).toBeInTheDocument()
    review.mockResolvedValueOnce({ id: 1, reviewState: 'pending', reviewActor: null })
    await userEvent.click(screen.getByRole('button', { name: /mark finding not useful/i }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument()
    )
  })
  it('a review-mode card never renders the strip or the why? button', async () => {
    list.mockResolvedValue([
      row({
        mode: 'review',
        reviewState: 'rejected',
        reviewActor: 'human',
        diffPath: 'r/a.ts',
        diffLine: 1
      })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    await screen.findByText('Race in parser')
    expect(screen.queryByRole('button', { name: /reject reason/ })).not.toBeInTheDocument()
  })
})
