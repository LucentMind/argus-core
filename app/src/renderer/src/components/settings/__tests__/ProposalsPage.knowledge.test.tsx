// @vitest-environment jsdom
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ProposalsPage } from '../ProposalsPage'
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
  accept = vi
    .fn()
    .mockResolvedValue({ proposals: [], accepted: { kind: 'memory', name: 'dlt-timing' } })
  ;(window as unknown as { argus: unknown }).argus = {
    proposals: {
      list: vi.fn().mockResolvedValue(payload),
      accept,
      reject: vi.fn().mockResolvedValue({ proposals: [] })
    },
    settings: {
      get: vi.fn(async () => ({ settings: { hivemind: { repo: 'org/hive' } }, loadError: null })),
      onChanged: vi.fn(() => () => {})
    }
  }
})

describe('Knowledge inbox', () => {
  it('shows Lesson / Case summary labels, previously-reviewed badge, and case groups', async () => {
    render(<ProposalsPage />)
    expect(await screen.findByText('Lesson', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('Case summary', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText(/previously reviewed/i)).toBeInTheDocument()
    expect(screen.getByText(/case-a/)).toBeInTheDocument()
    expect(screen.getByText(/case-b/)).toBeInTheDocument()
  })

  it('filters by type', async () => {
    render(<ProposalsPage />)
    await screen.findByText('DLT drift')
    fireEvent.click(screen.getByRole('button', { name: 'Filter Case summary' }))
    expect(screen.queryByText('DLT drift')).not.toBeInTheDocument()
    expect(screen.getByText('Case summary: sig')).toBeInTheDocument()
  })

  it('edit-then-accept passes edited content', async () => {
    render(<ProposalsPage />)
    await screen.findByText('DLT drift')
    fireEvent.click(screen.getByRole('button', { name: 'Edit DLT drift' }))
    const ta = screen.getByLabelText('Edit proposal content')
    fireEvent.change(ta, { target: { value: 'edited fact' } })
    fireEvent.click(screen.getByRole('button', { name: 'Accept DLT drift' }))
    await waitFor(() => expect(accept).toHaveBeenCalledWith('a.md', 'edited fact'))
  })

  it('shows the memory-append target topic chip but not one for case-summary', async () => {
    render(<ProposalsPage />)
    await screen.findByText('DLT drift')
    expect(screen.getByText('→ dlt-timing')).toBeInTheDocument()
    const summaryCard = screen.getByText('Case summary: sig').closest('section') as HTMLElement
    expect(within(summaryCard).queryByText(/^→/)).not.toBeInTheDocument()
  })

  it('filter chips show human-readable type labels', async () => {
    render(<ProposalsPage />)
    await screen.findByText('DLT drift')
    expect(screen.getByRole('button', { name: 'Filter Lesson' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filter Case summary' })).toBeInTheDocument()
  })
})
