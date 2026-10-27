// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
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
    rca: { onRcaChanged: vi.fn(() => () => {}) },
    agent: { onEvent: vi.fn(() => () => undefined) }
  } as never
})

const chain = (): FindingRow[] => [
  row({ id: 6, summary: 'tilesVersion blocked', role: 'root-cause', reviewState: 'accepted' }),
  row({ id: 4, summary: 'Install rejected', role: 'contributing', causedBy: 6 }),
  row({ id: 2, summary: 'NoRoute offline', role: 'symptom', causedBy: 4 }),
  row({ id: 7, summary: 'Fallback never tried', status: 'hypothesis' }),
  row({
    id: 3,
    summary: 'Wrong idea',
    reviewState: 'rejected',
    reviewActor: 'agent',
    reviewReason: 'old build'
  })
]

describe('FindingsPane — chain index', () => {
  it('groups by section in tree order, indents children, and counts pending in the header', async () => {
    list.mockResolvedValue(chain())
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    await screen.findByText('tilesVersion blocked')
    expect(screen.getByText('Findings · 5 · 3 to review')).toBeInTheDocument()
    const root = screen.getByRole('list', { name: 'ROOT CAUSE' })
    const items = within(root).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('tilesVersion blocked'),
      expect.stringContaining('Install rejected'),
      expect.stringContaining('NoRoute offline')
    ])
    expect(items[1]).toHaveStyle({ marginLeft: '14px' })
    expect(items[2]).toHaveStyle({ marginLeft: '28px' })
    const unexplained = screen.getByRole('list', { name: 'UNEXPLAINED' })
    expect(within(unexplained).getByText('Fallback never tried')).toBeInTheDocument()
    // Ruled out is collapsed by default, with its count.
    const toggle = screen.getByRole('button', { name: 'RULED OUT · 1' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Wrong idea')).toBeNull()
    await userEvent.click(toggle)
    expect(screen.getByText('Wrong idea')).toBeInTheDocument()
  })

  it('a role edit on an open card goes through findings.update', async () => {
    list.mockResolvedValue(chain())
    update.mockImplementation(async (id: number, patch: { role?: string | null }) => ({
      ...chain()[3],
      ...patch,
      id
    }))
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByText('Fallback never tried'))
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'symptom')
    expect(update).toHaveBeenCalledWith(7, { role: 'symptom' })
    // The merged row drives the select (and the chip); the option text 'symptom' also exists, so
    // assert on the control's value, not on text.
    await waitFor(() =>
      expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('symptom')
    )
    // The cause picker offers the active findings of the case, never itself or a ruled-out one.
    const cause = screen.getByLabelText('Caused by') as HTMLSelectElement
    expect([...cause.options].map((o) => o.value)).toEqual(['', '6', '4', '2'])
  })

  it('a refused edit shows its reason', async () => {
    list.mockResolvedValue(chain())
    update.mockRejectedValue(new Error('That would make a loop in the chain.'))
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByText('Install rejected'))
    await userEvent.selectOptions(screen.getByLabelText('Caused by'), '2')
    expect(await screen.findByText('That would make a loop in the chain.')).toBeInTheDocument()
    // On the edited card itself, as an alert — the same as the inline chat card.
    const card = screen.getByRole('button', { name: 'Install rejected' }).closest('li')!
    expect(within(card).getByRole('alert')).toHaveTextContent(
      'That would make a loop in the chain.'
    )
  })

  it('Review walks the pending cards: a accepts and advances, s skips, Escape leaves', async () => {
    list.mockResolvedValue(chain())
    review.mockImplementation(async (id: number, state: string) => ({
      ...chain().find((f) => f.id === id)!,
      reviewState: state,
      body: undefined
    }))
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    await screen.findByText('tilesVersion blocked')
    await userEvent.click(screen.getByRole('button', { name: 'Review pending findings' }))
    const bar = screen.getByTestId('review-walk')
    expect(bar).toHaveTextContent('Reviewing 1 of 3')
    // Pending in tree order: #4, #2, #7. The current card is expanded.
    expect(screen.getByRole('button', { name: 'Install rejected' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    await userEvent.keyboard('a')
    expect(review).toHaveBeenCalledWith(4, 'accepted', undefined)
    await waitFor(() => expect(bar).toHaveTextContent('Reviewing 2 of 3'))
    await userEvent.keyboard('s')
    expect(bar).toHaveTextContent('Reviewing 3 of 3')
    await userEvent.keyboard('r')
    expect(review).toHaveBeenCalledWith(7, 'rejected', undefined)
    expect(await screen.findByTestId('finding-reject-strip')).toBeInTheDocument()
    // The reject moved #7 to RULED OUT and opened the section so the strip has somewhere to render.
    expect(screen.getByRole('button', { name: 'RULED OUT · 2' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('review-walk')).toBeNull()
    expect(screen.queryByTestId('finding-reject-strip')).toBeNull()
  })

  it('the walk scrolls its current card into view as it moves', async () => {
    // jsdom has no scrollIntoView: stub it on the prototype and record which element it ran on.
    const scrolled: Element[] = []
    const stub = vi.fn(function (this: Element) {
      scrolled.push(this)
    })
    Element.prototype.scrollIntoView = stub
    try {
      list.mockResolvedValue(chain())
      render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
      await screen.findByText('tilesVersion blocked')
      await userEvent.click(screen.getByRole('button', { name: 'Review pending findings' }))
      // Pending in tree order: #4, #2, #7 — the walk starts on #4.
      await waitFor(() => expect(scrolled.at(-1)).toHaveAttribute('data-finding-id', '4'))
      expect(stub).toHaveBeenLastCalledWith({ block: 'nearest' })
      await userEvent.keyboard('s')
      expect(screen.getByTestId('review-walk')).toHaveTextContent('Reviewing 2 of 3')
      await waitFor(() => expect(scrolled.at(-1)).toHaveAttribute('data-finding-id', '2'))
      const card = scrolled.at(-1) as HTMLElement
      expect(card.tagName).toBe('LI')
      expect(within(card).getByText('NoRoute offline')).toBeInTheDocument()
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('walk keys set a state, never flip it: revisiting an accepted card with a only advances', async () => {
    list.mockResolvedValue(chain())
    review.mockImplementation(async (id: number, state: string) => ({
      ...chain().find((f) => f.id === id)!,
      reviewState: state,
      body: undefined
    }))
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    await screen.findByText('tilesVersion blocked')
    await userEvent.click(screen.getByRole('button', { name: 'Review pending findings' }))
    const bar = screen.getByTestId('review-walk')
    await userEvent.keyboard('a')
    await waitFor(() => expect(bar).toHaveTextContent('Reviewing 2 of 3'))
    await userEvent.keyboard('k')
    expect(bar).toHaveTextContent('Reviewing 1 of 3')
    await userEvent.keyboard('a')
    expect(bar).toHaveTextContent('Reviewing 2 of 3')
    expect(review).toHaveBeenCalledTimes(1)
    expect(review).not.toHaveBeenCalledWith(4, 'pending', undefined)
  })

  it('r on an already-rejected card reopens the strip without toggling the reject back', async () => {
    list.mockResolvedValue(chain())
    review.mockImplementation(async (id: number, state: string) => ({
      ...chain().find((f) => f.id === id)!,
      reviewState: state,
      body: undefined
    }))
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    await screen.findByText('tilesVersion blocked')
    await userEvent.click(screen.getByRole('button', { name: 'Review pending findings' }))
    await userEvent.keyboard('r')
    expect(await screen.findByTestId('finding-reject-strip')).toBeInTheDocument()
    await userEvent.keyboard('r')
    expect(review).toHaveBeenCalledTimes(1)
    expect(review).toHaveBeenCalledWith(4, 'rejected', undefined)
    expect(screen.getByTestId('finding-reject-strip')).toBeInTheDocument()
    expect(screen.getByTestId('review-walk')).toHaveTextContent('Reviewing 1 of 3')
  })

  it('a refused accept (null) does not advance the walk', async () => {
    list.mockResolvedValue(chain())
    review.mockResolvedValue(null)
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    await screen.findByText('tilesVersion blocked')
    await userEvent.click(screen.getByRole('button', { name: 'Review pending findings' }))
    const bar = screen.getByTestId('review-walk')
    await userEvent.keyboard('a')
    await waitFor(() => expect(review).toHaveBeenCalledWith(4, 'accepted', undefined))
    // Let the settled promise's continuation run before asserting nothing moved.
    await act(async () => {})
    expect(bar).toHaveTextContent('Reviewing 1 of 3')
  })

  it('a failed accept (rejection) stays on the card and shows the reason as an alert', async () => {
    list.mockResolvedValue(chain())
    review.mockRejectedValue(new Error('Save failed.'))
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    await screen.findByText('tilesVersion blocked')
    await userEvent.click(screen.getByRole('button', { name: 'Review pending findings' }))
    await userEvent.keyboard('a')
    const card = screen.getByRole('button', { name: 'Install rejected' }).closest('li')!
    expect(await within(card).findByRole('alert')).toHaveTextContent('Save failed.')
    expect(screen.getByTestId('review-walk')).toHaveTextContent('Reviewing 1 of 3')
  })

  it('Review: j and k move, k stops at the first card, accepting the last pending ends the walk', async () => {
    list.mockResolvedValue(chain())
    review.mockImplementation(async (id: number, state: string) => ({
      ...chain().find((f) => f.id === id)!,
      reviewState: state,
      body: undefined
    }))
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    await screen.findByText('tilesVersion blocked')
    await userEvent.click(screen.getByRole('button', { name: 'Review pending findings' }))
    const bar = screen.getByTestId('review-walk')
    await userEvent.keyboard('k')
    expect(bar).toHaveTextContent('Reviewing 1 of 3')
    await userEvent.keyboard('jj')
    expect(bar).toHaveTextContent('Reviewing 3 of 3')
    expect(screen.getByRole('button', { name: 'Fallback never tried' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Install rejected' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await userEvent.keyboard('k')
    expect(bar).toHaveTextContent('Reviewing 2 of 3')
    await userEvent.keyboard('j')
    await userEvent.keyboard('a')
    expect(review).toHaveBeenCalledWith(7, 'accepted', undefined)
    await waitFor(() => expect(screen.queryByTestId('review-walk')).toBeNull())
    // The walk is over; the Review button is back while findings are still pending.
    expect(screen.getByRole('button', { name: 'Review pending findings' })).toBeInTheDocument()
    expect(screen.getByText('Findings · 5 · 2 to review')).toBeInTheDocument()
  })

  it('a mode switch ends the walk: review mode never shows it, and switching back does not resume it', async () => {
    list.mockResolvedValue(chain())
    const { rerender } = render(
      <FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />
    )
    await screen.findByText('tilesVersion blocked')
    await userEvent.click(screen.getByRole('button', { name: 'Review pending findings' }))
    expect(screen.getByTestId('review-walk')).toBeInTheDocument()
    rerender(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    expect(screen.queryByTestId('review-walk')).toBeNull()
    rerender(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    expect(screen.queryByTestId('review-walk')).toBeNull()
    expect(screen.getByRole('button', { name: 'Review pending findings' })).toBeInTheDocument()
  })

  it('review mode is untouched: no sections, no Review button, no editors', async () => {
    list.mockResolvedValue([
      row({
        id: 1,
        summary: 'Inverted guard',
        mode: 'review',
        layer: 'correctness',
        severity: 'major'
      })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    await screen.findByText('Inverted guard')
    expect(screen.queryByRole('list', { name: 'ROOT CAUSE' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review pending findings' })).toBeNull()
    expect(screen.getByText('Findings · 1')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Inverted guard'))
    expect(screen.getByRole('button', { name: 'Inverted guard' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.queryByTestId('chain-editors')).toBeNull()
  })
})
