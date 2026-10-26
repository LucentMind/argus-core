// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FindingCard } from '../FindingCard'
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
    ...over
  }
}

function mount(f: FindingRow, onWhy = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <ul>
      <FindingCard
        finding={f}
        slug="c1"
        open={false}
        selected={false}
        selectable={false}
        sessionId={1}
        actingId={null}
        worktreeHead={null}
        repoNames={[]}
        onToggle={() => {}}
        onSelect={() => {}}
        onReview={() => {}}
        onAction={() => {}}
        onCite={() => {}}
        onDelete={() => {}}
        onWhy={onWhy}
      />
    </ul>
  )
  return onWhy
}

describe('FindingCard human reject reason', () => {
  it('shows the tag label and the note on a tagged human reject, and reopens on click', async () => {
    const onWhy = mount(
      row({
        reviewState: 'rejected',
        reviewActor: 'human',
        rejectTag: 'wrong',
        rejectNote: 'old build'
      })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Change reject reason' }))
    expect(screen.getByText('Wrong')).toBeInTheDocument()
    expect(screen.getByText('old build')).toBeInTheDocument()
    expect(onWhy).toHaveBeenCalled()
  })
  it('shows a ghost why? on an untagged human reject', async () => {
    const onWhy = mount(row({ reviewState: 'rejected', reviewActor: 'human' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add reject reason' }))
    expect(onWhy).toHaveBeenCalled()
  })
  it('shows neither on an agent retraction, an accepted card, or a review-mode card', () => {
    mount(row({ reviewState: 'rejected', reviewActor: 'agent', reviewReason: 'r' }))
    mount(row({ id: 2, reviewState: 'accepted' }))
    mount(row({ id: 3, mode: 'review', reviewState: 'rejected', reviewActor: 'human' }))
    expect(screen.queryByRole('button', { name: /reject reason/ })).not.toBeInTheDocument()
    expect(screen.getByText('retracted by agent')).toBeInTheDocument()
  })
  it('renders the footer slot inside the card', () => {
    render(
      <ul>
        <FindingCard
          finding={row({})}
          slug="c1"
          open={false}
          selected={false}
          selectable={false}
          sessionId={1}
          actingId={null}
          worktreeHead={null}
          repoNames={[]}
          onToggle={() => {}}
          onSelect={() => {}}
          onReview={() => {}}
          onAction={() => {}}
          onCite={() => {}}
          onDelete={() => {}}
          footer={<div data-testid="footer">strip</div>}
        />
      </ul>
    )
    expect(screen.getByTestId('footer').closest('li')).not.toBeNull()
  })
})
