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
  onToggleTypes: ReturnType<typeof vi.fn>
} {
  const onSelect = vi.fn()
  const onToggleTypes = vi.fn()
  render(
    <ProposalQueue
      entries={entries}
      typesPresent={['skill-edit', 'skill-new', 'reference-edit']}
      countByType={{ 'skill-edit': 1, 'skill-new': 1, 'reference-edit': 1 }}
      activeTypes={new Set()}
      onToggleTypes={onToggleTypes}
      selectedFile="a.md"
      onSelect={onSelect}
      {...over}
    />
  )
  return { onSelect, onToggleTypes }
}

describe('ProposalQueue', () => {
  it('groups rows under case headers', () => {
    renderQueue()
    expect(screen.getByText('NAV-100')).toBeInTheDocument()
    expect(screen.getByText('ZED-7')).toBeInTheDocument()
  })

  // The column's own "Proposals · N pending" header is gone (user-directed, 2026-08-08): the top
  // bar carries exactly that line a few pixels above it. Pinned so it cannot creep back.
  it('renders no title or pending count of its own', () => {
    renderQueue()
    expect(screen.queryByText(/pending/)).not.toBeInTheDocument()
    expect(screen.queryByText('Proposals')).not.toBeInTheDocument()
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

  // One chip per ICON family, not per type (user-directed, 2026-08-08): the Skill chip owns
  // both skill-new and skill-edit, so its count sums them and a click moves both at once.
  it('filter chips are per icon family, carry the group count, and toggle the whole group', () => {
    const { onToggleTypes } = renderQueue()
    const skill = screen.getByRole('button', { name: 'Filter Skill' })
    expect(skill).toHaveTextContent('Skill · 2')
    fireEvent.click(skill)
    expect(onToggleTypes).toHaveBeenCalledWith(['skill-edit', 'skill-new'], true)
  })

  // A group already filtered in clears on the next click — `activeTypes` holding EITHER of its
  // types is enough to make the chip pressed, since the chip can only ever set or clear both.
  it('a pressed chip clears its whole group', () => {
    const { onToggleTypes } = renderQueue({ activeTypes: new Set(['skill-new']) })
    const skill = screen.getByRole('button', { name: 'Filter Skill' })
    expect(skill).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(skill)
    expect(onToggleTypes).toHaveBeenCalledWith(['skill-edit', 'skill-new'], false)
  })

  // Three chips at most, and only for families actually in the queue — the five per-type chips
  // this replaced ("Skill · new", "Skill · edit", "Reference", "Recipe", "Case summary") must
  // not come back.
  it('renders exactly the three family chips, and only those present', () => {
    renderQueue({
      typesPresent: ['skill-edit', 'skill-new', 'recipe', 'case-summary'],
      countByType: { 'skill-edit': 1, 'skill-new': 1, recipe: 3, 'case-summary': 1 }
    })
    // Recipe rides in the Reference family, so its count lands on that chip.
    expect(screen.getByRole('button', { name: 'Filter Reference' })).toHaveTextContent(
      'Reference · 3'
    )
    expect(screen.getByRole('button', { name: 'Filter Case summary' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Filter Skill · new' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Filter Recipe' })).not.toBeInTheDocument()
  })

  it('omits a family chip entirely when nothing in the queue belongs to it', () => {
    renderQueue({ typesPresent: ['skill-edit'], countByType: { 'skill-edit': 1 } })
    expect(screen.getByRole('button', { name: 'Filter Skill' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Filter Reference' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Filter Case summary' })).not.toBeInTheDocument()
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
