// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
    status: 'confirmed',
    roleSource: null,
    causedBy: null,
    supersededBy: null,
    body: 'A body.',
    ...over
  }
}

function mount(f: FindingRow, extra: Partial<React.ComponentProps<typeof FindingCard>> = {}): void {
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
        {...extra}
      />
    </ul>
  )
}

describe('FindingCard — chain', () => {
  it('marks a hypothesis with a dashed border and a chip; a confirmed finding has neither', () => {
    mount(row({ status: 'hypothesis' }))
    const li = screen.getByText('Race in parser').closest('li')!
    expect(li.className).toContain('border-dashed')
    expect(li).toHaveAttribute('data-status', 'hypothesis')
    expect(screen.getByTestId('status-chip')).toHaveTextContent('hypothesis')
    cleanup()

    mount(row({ status: 'confirmed' }))
    const confirmed = screen.getByText('Race in parser').closest('li')!
    expect(confirmed.className).not.toContain('border-dashed')
    expect(confirmed).toHaveAttribute('data-status', 'confirmed')
    expect(screen.queryByTestId('status-chip')).toBeNull()
  })

  it('shows the cause, the role with its source, and indents by depth', () => {
    mount(row({ causedBy: 6, role: 'symptom', roleSource: 'human' }), { depth: 2 })
    expect(screen.getByTestId('caused-by-chip')).toHaveTextContent('caused by #6')
    expect(screen.getByText('symptom')).toHaveAttribute('title', 'set by human')
    expect(screen.getByText('Race in parser').closest('li')).toHaveStyle({ marginLeft: '28px' })
    expect(screen.queryByTestId('status-chip')).toBeNull()
  })

  it('offers role and cause editors on an open investigation card, calling onEdit with null to clear', async () => {
    const onEdit = vi.fn()
    mount(row({ role: 'symptom', causedBy: 6 }), {
      open: true,
      onEdit,
      causeOptions: [
        { id: 1, summary: 'Race in parser' },
        { id: 6, summary: 'Server blocks version' },
        { id: 9, summary: 'Other' }
      ]
    })
    const editors = screen.getByTestId('chain-editors')
    const role = screen.getByLabelText('Role') as HTMLSelectElement
    const cause = screen.getByLabelText('Caused by') as HTMLSelectElement
    expect(editors).toBeInTheDocument()
    expect(role.value).toBe('symptom')
    expect(cause.value).toBe('6')
    // Itself is never an option.
    expect([...cause.options].map((o) => o.value)).toEqual(['', '6', '9'])
    await userEvent.selectOptions(role, 'root-cause')
    expect(onEdit).toHaveBeenLastCalledWith({ role: 'root-cause' })
    await userEvent.selectOptions(cause, '')
    expect(onEdit).toHaveBeenLastCalledWith({ causedBy: null })
  })

  it('keeps an inactive stored cause selected and lets the human clear it', async () => {
    const onEdit = vi.fn()
    // #6 was rejected, so it is not among the selectable (active) options.
    mount(row({ causedBy: 6 }), {
      open: true,
      onEdit,
      causeOptions: [
        { id: 1, summary: 'Race in parser' },
        { id: 9, summary: 'Other' }
      ]
    })
    const cause = screen.getByLabelText('Caused by') as HTMLSelectElement
    expect(cause.value).toBe(String(6))
    expect([...cause.options].map((o) => o.value)).toEqual(['', '9', '6'])
    expect(cause.selectedOptions[0]).toHaveTextContent('#6 (inactive)')
    await userEvent.selectOptions(cause, '')
    expect(onEdit).toHaveBeenLastCalledWith({ causedBy: null })
  })

  it('renders no editors on a closed card, on a review card, or without onEdit', () => {
    mount(row({}), { open: false, onEdit: vi.fn() })
    expect(screen.queryByTestId('chain-editors')).toBeNull()
    cleanup()

    mount(row({ mode: 'review' }), { open: true, onEdit: vi.fn() })
    expect(screen.queryByTestId('chain-editors')).toBeNull()
    cleanup()

    mount(row({}), { open: true })
    expect(screen.queryByTestId('chain-editors')).toBeNull()
  })

  it('a review card shows no status chip, no cause chip and no dashed border', () => {
    mount(row({ mode: 'review', status: 'hypothesis', causedBy: 6 }))
    expect(screen.queryByTestId('status-chip')).toBeNull()
    expect(screen.queryByTestId('caused-by-chip')).toBeNull()
    const li = screen.getByText('Race in parser').closest('li')!
    expect(li.className).not.toContain('border-dashed')
    expect(li).not.toHaveAttribute('data-status')
    cleanup()

    mount(row({ mode: 'review' }), { depth: 2 })
    expect(screen.getByText('Race in parser').closest('li')!.style.marginLeft).toBe('')
  })
  it('names the cause on the chip and lists an inactive stored cause with its summary', async () => {
    mount(row({ causedBy: 3 }), {
      open: true,
      onEdit: () => {},
      causeOptions: [
        { id: 2, summary: 'Live cause' },
        { id: 3, summary: 'Withdrawn cause', inactive: true }
      ]
    })
    expect(screen.getByTestId('caused-by-chip')).toHaveTextContent(
      'caused by #3 · Withdrawn cause (inactive)'
    )
    const select = screen.getByLabelText('Caused by') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'none',
      '#2 Live cause',
      '#3 · Withdrawn cause (inactive)'
    ])
    expect(select.value).toBe('3')
  })
  it('renders a note line when given one', () => {
    mount(row({ reviewState: 'accepted' }), {
      note: 'the agent changed this finding; your accept stands'
    })
    expect(screen.getByTestId('finding-note')).toHaveTextContent(
      'the agent changed this finding; your accept stands'
    )
  })
})
