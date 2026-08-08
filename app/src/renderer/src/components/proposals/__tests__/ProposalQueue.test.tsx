// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ProposalQueue, type QueueEntry } from '../ProposalQueue'

const entries: QueueEntry[] = [
  {
    kind: 'pending',
    file: 'a.md',
    title: 'Sharpen step 4',
    caseSlug: 'NAV-100',
    date: '2026-07-10T12:00:00.000Z',
    type: 'skill-edit',
    target: 'rca',
    isNew: false,
    locked: false,
    previouslyReviewed: false
  },
  {
    kind: 'pending',
    file: 'b.md',
    title: 'New skill proposal',
    caseSlug: 'NAV-100',
    date: '2026-07-11T12:00:00.000Z',
    type: 'skill-new',
    target: 'new-skill',
    isNew: true,
    locked: false,
    previouslyReviewed: false
  },
  {
    kind: 'accepted',
    file: 'c.md',
    title: 'Ref accepted earlier',
    caseSlug: 'ZED-7',
    date: '2026-07-12T12:00:00.000Z',
    type: 'reference-edit',
    target: 'ref-doc',
    isNew: false,
    locked: false,
    previouslyReviewed: false
  }
]

function renderQueue(over: Partial<Parameters<typeof ProposalQueue>[0]> = {}): {
  onSelect: ReturnType<typeof vi.fn>
  onToggleType: ReturnType<typeof vi.fn>
} {
  const onSelect = vi.fn()
  const onToggleType = vi.fn()
  render(
    <ProposalQueue
      entries={entries}
      pendingCount={2}
      typesPresent={['skill-edit', 'skill-new', 'reference-edit']}
      countByType={{ 'skill-edit': 1, 'skill-new': 1, 'reference-edit': 1 }}
      activeTypes={new Set()}
      onToggleType={onToggleType}
      selectedFile="a.md"
      onSelect={onSelect}
      {...over}
    />
  )
  return { onSelect, onToggleType }
}

describe('ProposalQueue', () => {
  it('groups rows under case headers and shows the pending count', () => {
    renderQueue()
    expect(screen.getByText('NAV-100')).toBeInTheDocument()
    expect(screen.getByText('ZED-7')).toBeInTheDocument()
    expect(screen.getByText('2 pending')).toBeInTheDocument()
  })

  it('marks the selected row aria-current and fires onSelect on click', () => {
    const { onSelect } = renderQueue()
    expect(screen.getByRole('button', { name: 'Select proposal Sharpen step 4' })).toHaveAttribute(
      'aria-current',
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Select proposal New skill proposal' }))
    expect(onSelect).toHaveBeenCalledWith('b.md')
  })

  it('shows badges: new file on isNew rows, accepted state on accepted rows', () => {
    renderQueue()
    expect(screen.getByText('new')).toBeInTheDocument()
    expect(screen.getByText('accepted')).toBeInTheDocument()
  })

  it('filter chips carry counts and toggle', () => {
    const { onToggleType } = renderQueue()
    fireEvent.click(screen.getByRole('button', { name: 'Filter Skill · new' }))
    expect(onToggleType).toHaveBeenCalledWith('skill-new')
  })

  // Ported from ProposalsPage.knowledge.test.tsx's "filter chips show human-readable
  // type labels" — the label dictionary itself isn't exercised elsewhere.
  it('filter chips render human-readable labels for every present type', () => {
    renderQueue({
      typesPresent: ['skill-edit', 'skill-new', 'reference-edit', 'case-summary'],
      countByType: { 'skill-edit': 1, 'skill-new': 1, 'reference-edit': 1, 'case-summary': 1 }
    })
    expect(screen.getByRole('button', { name: 'Filter Reference' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filter Case summary' })).toBeInTheDocument()
  })

  // Ported from ProposalsPage.knowledge.test.tsx's "shows Reference / Case summary
  // labels, previously-reviewed badge, and case groups" — the badge half; the label
  // half is covered by ProposalDetail's own header-chip test, and case groups are
  // covered by the "groups rows under case headers" test above.
  it('shows a "seen before" badge for previously-reviewed rows', () => {
    renderQueue({
      entries: [{ ...entries[0], previouslyReviewed: true }]
    })
    expect(screen.getByText('seen before')).toBeInTheDocument()
  })
})
