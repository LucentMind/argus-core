// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { RelatedHistoryExplorer } from '../RelatedHistoryExplorer'
import type {
  LocalCaseHit,
  RelatedSearchResult,
  RelatedSourceInfo
} from '../../../../../shared/relatedHistory'

const hit = (over: Partial<LocalCaseHit> = {}): LocalCaseHit => ({
  kind: 'local',
  id: 'local:old',
  caseSlug: 'old',
  jiraKey: null,
  provenance: [{ providerId: 'local', providerName: 'Your cases', kind: 'local' }],
  title: 'ECU reset drifts DLT',
  snippet: '«ECU»',
  matchedOn: 'lexical',
  rank: 1,
  fusedScore: 0.016,
  status: { label: 'solved', tone: 'resolved' },
  distilled: null,
  ...over
})

const SOURCES: RelatedSourceInfo[] = [
  { id: 'local', name: 'Your cases', kind: 'local', ok: true, semantic: false, projects: [] }
]

function setArgus(
  result: Partial<RelatedSearchResult>,
  sources: RelatedSourceInfo[] = SOURCES
): { search: ReturnType<typeof vi.fn> } {
  const search = vi.fn().mockResolvedValue({ query: 'q', hits: [], sources: [], ...result })
  ;(window as unknown as { argus: unknown }).argus = {
    related: { search, sources: vi.fn().mockResolvedValue(sources), defect: vi.fn() }
  }
  return { search }
}

describe('RelatedHistoryExplorer', () => {
  it('seeds the query box from the case-composed query it gets back', async () => {
    const { search } = setArgus({ query: 'ecu reset drifts dlt', hits: [hit()] })
    render(<RelatedHistoryExplorer caseSlug="current" />)
    await waitFor(() =>
      expect(screen.getByLabelText('Search related history')).toHaveValue('ecu reset drifts dlt')
    )
    // The seeding request sends caseSlug only — the composed query lives in main.
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ caseSlug: 'current' }))
    expect(search.mock.calls[0][0].query).toBeUndefined()
  })

  it('switches to a free-form request once the box is edited', async () => {
    const { search } = setArgus({ query: 'seeded', hits: [] })
    render(<RelatedHistoryExplorer caseSlug="current" />)
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Search related history'), {
      target: { value: 'battery soc' }
    })
    fireEvent.submit(screen.getByRole('search'))
    await waitFor(() =>
      // caseSlug stays so the current case is still excluded from local results.
      expect(search).toHaveBeenLastCalledWith(
        expect.objectContaining({ caseSlug: 'current', query: 'battery soc' })
      )
    )
  })

  it('sends nothing at all until a standalone query is typed', async () => {
    const { search } = setArgus({ hits: [] })
    render(<RelatedHistoryExplorer />)
    await waitFor(() =>
      expect(screen.getByText(/Search your cases and every configured corpus/)).toBeInTheDocument()
    )
    expect(search).not.toHaveBeenCalled()
  })

  it('raises the limit on show-more and stops at the contract ceiling', async () => {
    // A full page every step, so "Show more" keeps offering — otherwise the
    // component would stop paging on its own before the ceiling is reached
    // and the test would prove nothing about the stop condition either.
    const search = vi.fn().mockImplementation((input: { limit: number }) =>
      Promise.resolve({
        query: 'q',
        hits: Array.from({ length: input.limit }, () => hit()),
        sources: []
      })
    )
    ;(window as unknown as { argus: unknown }).argus = {
      related: { search, sources: vi.fn().mockResolvedValue(SOURCES), defect: vi.fn() }
    }
    render(<RelatedHistoryExplorer caseSlug="current" />)
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))

    const expectedLimits = [10, 20, 30, 40, 50]
    expect(search.mock.calls[0][0].limit).toBe(expectedLimits[0])
    for (let i = 1; i < expectedLimits.length; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(i + 1))
      expect(search.mock.calls[i][0].limit).toBe(expectedLimits[i])
    }
    // Every requested limit stayed within the server-enforced ceiling...
    for (const call of search.mock.calls) {
      expect(call[0].limit).toBeLessThanOrEqual(50)
    }
    // ...and once the ceiling is reached, the component stops offering more.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
    )
    expect(search).toHaveBeenCalledTimes(expectedLimits.length)
  })

  it('clears loading and shows a retry-ready failure line when search rejects', async () => {
    const search = vi.fn().mockRejectedValue(new Error('fetch failed'))
    ;(window as unknown as { argus: unknown }).argus = {
      related: { search, sources: vi.fn().mockResolvedValue(SOURCES), defect: vi.fn() }
    }
    render(<RelatedHistoryExplorer caseSlug="current" />)
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))

    // The failure is visible, human-readable text in the results area — not a
    // silently blank pane.
    expect(await screen.findByText('fetch failed')).toBeInTheDocument()
    // Neither the empty-result nor the standalone placeholder mislabels the
    // failure as "nothing matched".
    expect(screen.queryByText('No related history for this query.')).not.toBeInTheDocument()

    // The pane isn't stuck "loading": the query box and Search button are
    // still usable, and resubmitting is the retry path.
    const input = screen.getByLabelText('Search related history')
    const button = screen.getByRole('button', { name: 'Search' })
    expect(input).toBeEnabled()
    expect(button).toBeEnabled()

    // Zero hits on the retry: this only renders once `loading` has actually
    // returned to false again for the new request — if the rejected request
    // had left `loading` wedged true forever, this message could never show.
    search.mockResolvedValueOnce({ query: 'q', hits: [], sources: [] })
    fireEvent.change(input, { target: { value: 'battery soc' } })
    fireEvent.submit(screen.getByRole('search'))
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No related history for this query.')).toBeInTheDocument()
    expect(screen.queryByText('fetch failed')).not.toBeInTheDocument()
  })

  it('renders the degraded line and keeps healthy hits visible', async () => {
    setArgus({
      query: 'q',
      hits: [hit()],
      sources: [
        { id: 'local', name: 'Your cases', kind: 'local', ok: true },
        { id: 'corpus:src1', name: 'Hindsight', kind: 'corpus', ok: false, error: 'fetch failed' }
      ]
    })
    render(<RelatedHistoryExplorer caseSlug="current" />)
    expect(await screen.findByText('ECU reset drifts DLT')).toBeInTheDocument()
    expect(screen.getByText(/Hindsight unavailable/)).toBeInTheDocument()
  })

  it('says nothing matched only when every source is healthy', async () => {
    setArgus({
      query: 'q',
      hits: [],
      sources: [{ id: 'local', name: 'Your cases', kind: 'local', ok: true }]
    })
    render(<RelatedHistoryExplorer caseSlug="current" />)
    expect(await screen.findByText('No related history for this query.')).toBeInTheDocument()
  })

  it('never offers a pull-into-case action (increment 3)', async () => {
    setArgus({ query: 'q', hits: [hit()] })
    render(<RelatedHistoryExplorer caseSlug="current" />)
    await screen.findByText('ECU reset drifts DLT')
    expect(screen.queryByRole('button', { name: /Reference in chat/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Attach as evidence/ })).not.toBeInTheDocument()
  })
})
