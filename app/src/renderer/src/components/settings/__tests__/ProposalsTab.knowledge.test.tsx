// @vitest-environment jsdom
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ProposalsTab } from '../ProposalsTab'
import type { ProposalsPayload } from '../../../../../shared/proposals'

const payload: ProposalsPayload = {
  proposals: [
    {
      file: 'a.md',
      type: 'memory-append',
      target: 'dlt-timing',
      caseSlug: 'case-a',
      date: '2026-07-16',
      title: 'DLT drift',
      content: 'fact body',
      current: null,
      previouslyReviewed: true
    },
    {
      file: 'b.md',
      type: 'case-summary',
      target: 'case-a',
      caseSlug: 'case-a',
      date: '2026-07-16',
      title: 'Case summary: sig',
      content: '# Summary body',
      current: null
    },
    {
      file: 'c.md',
      type: 'skill-edit',
      target: 'analyze-dlt',
      caseSlug: 'case-b',
      date: '2026-07-15',
      title: 'Better step',
      content: 'skill body',
      current: 'old'
    }
  ]
}

let accept: ReturnType<typeof vi.fn>
beforeEach(() => {
  accept = vi.fn().mockResolvedValue({ proposals: [] })
  ;(window as unknown as { argus: unknown }).argus = {
    proposals: {
      list: vi.fn().mockResolvedValue(payload),
      accept,
      reject: vi.fn().mockResolvedValue({ proposals: [] })
    }
  }
})

describe('Knowledge inbox', () => {
  it('shows Lesson / Case summary labels, previously-reviewed badge, and case groups', async () => {
    render(<ProposalsTab onCountChange={() => undefined} />)
    expect(await screen.findByText('Lesson', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('Case summary', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText(/previously reviewed/i)).toBeInTheDocument()
    expect(screen.getByText(/case-a/)).toBeInTheDocument()
    expect(screen.getByText(/case-b/)).toBeInTheDocument()
  })

  it('filters by type', async () => {
    render(<ProposalsTab onCountChange={() => undefined} />)
    await screen.findByText('DLT drift')
    fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'case-summary' } })
    expect(screen.queryByText('DLT drift')).not.toBeInTheDocument()
    expect(screen.getByText('Case summary: sig')).toBeInTheDocument()
  })

  it('edit-then-accept passes edited content', async () => {
    render(<ProposalsTab onCountChange={() => undefined} />)
    await screen.findByText('DLT drift')
    fireEvent.click(screen.getAllByRole('button', { name: /edit/i })[0])
    const ta = screen.getByLabelText('Edit proposal content')
    fireEvent.change(ta, { target: { value: 'edited fact' } })
    fireEvent.click(screen.getAllByRole('button', { name: /accept/i })[0])
    await waitFor(() => expect(accept).toHaveBeenCalledWith('a.md', 'edited fact'))
  })

  it('shows the memory-append target topic chip but not one for case-summary', async () => {
    render(<ProposalsTab onCountChange={() => undefined} />)
    await screen.findByText('DLT drift')
    expect(screen.getByText('→ dlt-timing')).toBeInTheDocument()
    const summaryCard = screen.getByText('Case summary: sig').closest('section') as HTMLElement
    expect(within(summaryCard).queryByText(/^→/)).not.toBeInTheDocument()
  })

  it('filter select options show human-readable type labels', async () => {
    render(<ProposalsTab onCountChange={() => undefined} />)
    await screen.findByText('DLT drift')
    const select = within(screen.getByLabelText('Filter by type'))
    expect(select.getByRole('option', { name: 'Lesson' })).toBeInTheDocument()
    expect(select.getByRole('option', { name: 'Case summary' })).toBeInTheDocument()
  })
})
