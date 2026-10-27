// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FindingsDocument } from '../FindingsDocument'
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
    body: 'b',
    ...over
  }
}
const list = vi.fn()
const review = vi.fn()
const update = vi.fn()
beforeEach(() => {
  findingsStore.clearForTests()
  list.mockReset()
  review.mockReset()
  update.mockReset()
  window.argus = {
    findings: { list, review, update, clear: vi.fn(), delete: vi.fn() },
    review: { worktreeHead: vi.fn().mockResolvedValue(null) },
    agent: { onEvent: vi.fn(() => () => undefined) }
  } as never
})
const chain = (): FindingRow[] => [
  row({
    id: 6,
    summary: 'tilesVersion blocked',
    body: 'root body',
    role: 'root-cause',
    reviewState: 'accepted'
  }),
  row({ id: 4, summary: 'Install rejected', body: 'mid body', role: 'contributing', causedBy: 6 }),
  row({ id: 2, summary: 'NoRoute offline', body: 'leaf body', role: 'symptom', causedBy: 4 }),
  row({ id: 7, summary: 'Fallback never tried', body: 'hyp body', status: 'hypothesis' }),
  row({
    id: 3,
    summary: 'Wrong idea',
    body: 'old body',
    reviewState: 'rejected',
    reviewActor: 'agent',
    reviewReason: 'old build'
  }),
  row({ id: 9, summary: 'PR issue', mode: 'review', layer: 'correctness', severity: 'major' })
]

describe('FindingsDocument', () => {
  it('renders the sections in tree order with every active body open, RULED OUT collapsed, review rows excluded', async () => {
    list.mockResolvedValue(chain())
    render(<FindingsDocument slug="c1" sessionId={1} onCite={vi.fn()} />)
    await screen.findByText('tilesVersion blocked')
    expect(screen.getByText('Findings · 5 · 3 to review')).toBeInTheDocument()
    const root = within(screen.getByRole('region', { name: 'ROOT CAUSE' }))
    expect(root.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('root body'),
      expect.stringContaining('mid body'),
      expect.stringContaining('leaf body')
    ])
    expect(root.getAllByRole('listitem')[2]).toHaveStyle({ marginLeft: '28px' })
    expect(
      within(screen.getByRole('region', { name: 'UNEXPLAINED' })).getByText('hyp body')
    ).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'RULED OUT · 1' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('old body')).toBeNull()
    await userEvent.click(toggle)
    expect(screen.getByText('old body')).toBeInTheDocument()
    expect(screen.queryByText('PR issue')).toBeNull()
  })
  it('a chevron collapses one body; thumbs and editors go through the store', async () => {
    list.mockResolvedValue(chain())
    review.mockImplementation(async (id: number, state: string) => ({
      ...chain().find((f) => f.id === id)!,
      reviewState: state,
      body: undefined
    }))
    update.mockImplementation(async (id: number, patch: { role?: string | null }) => ({
      ...chain().find((f) => f.id === id)!,
      ...patch
    }))
    render(<FindingsDocument slug="c1" sessionId={1} onCite={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Install rejected' }))
    expect(screen.queryByText('mid body')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Install rejected' }))
    expect(screen.getByText('mid body')).toBeInTheDocument()
    const hyp = screen.getByText('hyp body').closest('li')!
    await userEvent.click(within(hyp).getByRole('button', { name: /mark finding good/i }))
    expect(review).toHaveBeenCalledWith(7, 'accepted', undefined)
    await userEvent.selectOptions(within(hyp).getByLabelText('Role'), 'symptom')
    expect(update).toHaveBeenCalledWith(7, { role: 'symptom' })
  })
  it('the Review walk runs here too: a accepts and advances, Escape ends', async () => {
    list.mockResolvedValue(chain())
    review.mockImplementation(async (id: number, state: string) => ({
      ...chain().find((f) => f.id === id)!,
      reviewState: state,
      body: undefined
    }))
    render(<FindingsDocument slug="c1" sessionId={1} onCite={vi.fn()} />)
    await screen.findByText('tilesVersion blocked')
    await userEvent.click(screen.getByRole('button', { name: 'Review pending findings' }))
    expect(screen.getByTestId('review-walk')).toHaveTextContent('Reviewing 1 of 3')
    await userEvent.keyboard('a')
    expect(review).toHaveBeenCalledWith(4, 'accepted', undefined)
    await waitFor(() =>
      expect(screen.getByTestId('review-walk')).toHaveTextContent('Reviewing 2 of 3')
    )
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('review-walk')).toBeNull()
  })
  it('shows the empty state', async () => {
    list.mockResolvedValue([])
    render(<FindingsDocument slug="c1" sessionId={1} onCite={vi.fn()} />)
    expect(await screen.findByText('No findings yet.')).toBeInTheDocument()
  })
})
