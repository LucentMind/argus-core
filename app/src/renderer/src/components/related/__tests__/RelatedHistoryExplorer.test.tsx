// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { RelatedHistoryExplorer, RelatedHistoryExplorerModal } from '../RelatedHistoryExplorer'
import type {
  CorpusDefectHit,
  LocalCaseHit,
  RelatedSearchInput,
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

const corpusHit = (over: Partial<CorpusDefectHit> = {}): CorpusDefectHit => ({
  kind: 'corpus',
  id: 'corpus:src1:KAN-5',
  sourceId: 'src1',
  key: 'KAN-5',
  url: 'https://corpus.example/browse/KAN-5',
  provenance: [{ providerId: 'corpus:src1', providerName: 'Hindsight', kind: 'corpus' }],
  title: 'charge plan dropped',
  snippet: null,
  matchedOn: 'lexical',
  rank: 1,
  fusedScore: 0.016,
  status: { label: 'Done / Fixed', tone: 'resolved' },
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

  /**
   * One pane until a result is picked (user-directed, 2026-08-08). The detail column used to be
   * permanent, half the width given over to a "Select a result…" placeholder while the results
   * themselves were squeezed into the other half.
   *
   * Keyed on the presence of the hit's own detail content rather than on a class name, so the
   * assertion survives a layout rewrite and still fails if the pane comes back uninvited.
   */
  describe('detail pane', () => {
    it('shows no detail pane until a result is selected, then splits', async () => {
      setArgus({ query: 'q', hits: [hit()] })
      render(<RelatedHistoryExplorer caseSlug="current" />)
      const row = await screen.findByText('ECU reset drifts DLT')
      expect(screen.queryByRole('button', { name: 'Close detail' })).toBeNull()

      fireEvent.click(row)
      expect(await screen.findByRole('button', { name: 'Close detail' })).toBeInTheDocument()
    })

    it('closes the detail pane again, returning to a single pane', async () => {
      setArgus({ query: 'q', hits: [hit()] })
      render(<RelatedHistoryExplorer caseSlug="current" />)
      fireEvent.click(await screen.findByText('ECU reset drifts DLT'))

      fireEvent.click(await screen.findByRole('button', { name: 'Close detail' }))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Close detail' })).toBeNull())
      // The result list is still there — closing the detail must not clear the search.
      expect(screen.getByText('ECU reset drifts DLT')).toBeInTheDocument()
    })

    /** No state of its own to reset: `active` is `selected` looked up in the CURRENT hits, so a
     *  search that no longer returns that row collapses the split by construction. */
    it('collapses when a later search no longer returns the selected hit', async () => {
      const search = vi
        .fn()
        .mockResolvedValueOnce({ query: 'q', hits: [hit()], sources: [] })
        .mockResolvedValue({ query: 'q', hits: [], sources: [] })
      ;(window as unknown as { argus: unknown }).argus = {
        related: { search, sources: vi.fn().mockResolvedValue(SOURCES), defect: vi.fn() }
      }
      render(<RelatedHistoryExplorer caseSlug="current" />)
      fireEvent.click(await screen.findByText('ECU reset drifts DLT'))
      expect(await screen.findByRole('button', { name: 'Close detail' })).toBeInTheDocument()

      fireEvent.change(screen.getByLabelText('Search related history'), {
        target: { value: 'something else' }
      })
      fireEvent.submit(screen.getByRole('search'))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Close detail' })).toBeNull())
    })
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

  it("drops the previous search's hits and show-more control when a later search fails", async () => {
    // First search succeeds with a full page (so "Show more" is offered).
    // Second search — after an edit + resubmit, i.e. a new `req` — rejects.
    // The stale hits and the show-more control (which would resubmit the
    // *failing* req at a higher limit) must both disappear; only the error
    // line should remain.
    const search = vi.fn()
    search.mockResolvedValueOnce({
      query: 'q',
      hits: Array.from({ length: 10 }, (_, i) => hit({ id: `local:${i}` })),
      sources: []
    })
    search.mockRejectedValueOnce(new Error('fetch failed'))
    ;(window as unknown as { argus: unknown }).argus = {
      related: { search, sources: vi.fn().mockResolvedValue(SOURCES), defect: vi.fn() }
    }
    render(<RelatedHistoryExplorer caseSlug="current" />)
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('button', { name: 'Show more' })).toBeInTheDocument()
    expect(screen.getAllByText('ECU reset drifts DLT').length).toBe(10)

    fireEvent.change(screen.getByLabelText('Search related history'), {
      target: { value: 'battery soc' }
    })
    fireEvent.submit(screen.getByRole('search'))
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2))

    expect(await screen.findByText('fetch failed')).toBeInTheDocument()
    expect(screen.queryByText('ECU reset drifts DLT')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
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

  // Minor 1: `no-providers` and `query-too-generic` used to render the same
  // "nothing matched" copy, which misdescribes `no-providers` — reachable now
  // just by unchecking every rail row (Important 1 made an empty
  // `providerIds` mean "nothing", not "everything") — as a failed search
  // rather than "you asked for nothing".
  // The previous fixture here paired a probe listing `local` with a
  // `no-providers` search result while nothing was excluded — a state main
  // can never actually produce: with nothing excluded, `sources()` listing
  // `local` and `providers()` including it both gate on the exact same
  // `summaryPopulation(db, true)` call (see `RelatedHistoryService.sources`
  // and `.providers`), so if the probe reports `local` the fan-out would
  // too. A genuine `no-providers` with `hasKnownSources` true — the
  // combination this message needs — is reachable instead by the user
  // unchecking the only known source, which sends an explicit `providerIds:
  // []` and makes `providers()` itself filter down to nothing.
  it('renders a distinct message for reason: no-providers', async () => {
    const CORPUS_SOURCE: RelatedSourceInfo[] = [
      { id: 'corpus:a', name: 'Corpus A', kind: 'corpus', ok: true, semantic: false, projects: [] }
    ]
    const search = vi.fn().mockImplementation((input: RelatedSearchInput) => {
      const excludedEverything = input.providerIds !== undefined && input.providerIds.length === 0
      return Promise.resolve(
        excludedEverything
          ? { query: 'q', hits: [], sources: [], reason: 'no-providers' as const }
          : {
              query: 'q',
              hits: [],
              sources: [{ id: 'corpus:a', name: 'Corpus A', kind: 'corpus', ok: true }]
            }
      )
    })
    ;(window as unknown as { argus: unknown }).argus = {
      related: { search, sources: vi.fn().mockResolvedValue(CORPUS_SOURCE), defect: vi.fn() }
    }
    render(<RelatedHistoryExplorer caseSlug="current" />)
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByLabelText('Search Corpus A'))
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2))

    expect(await screen.findByText(/No sources are selected/)).toBeInTheDocument()
    expect(screen.queryByText('No related history for this query.')).not.toBeInTheDocument()
  })

  it('renders a distinct message for reason: query-too-generic', async () => {
    setArgus({
      query: 'q',
      hits: [],
      sources: [{ id: 'local', name: 'Your cases', kind: 'local', ok: true }],
      reason: 'query-too-generic'
    })
    render(<RelatedHistoryExplorer caseSlug="current" />)
    expect(await screen.findByText(/too generic/)).toBeInTheDocument()
    expect(screen.queryByText('No related history for this query.')).not.toBeInTheDocument()
  })

  // Important 1 & 2: no existing test exercises `toInput`'s `providerIds` /
  // `includeOpenCases` branches against the actual outgoing request — the rail
  // unit tests only assert the callback *patch*, which passes regardless of
  // what `toInput` does with it.
  describe('provider selection reaches the outgoing request', () => {
    const TWO_SOURCES: RelatedSourceInfo[] = [
      { id: 'local', name: 'Your cases', kind: 'local', ok: true, semantic: false, projects: [] },
      {
        id: 'corpus:src1',
        name: 'Hindsight',
        kind: 'corpus',
        ok: true,
        semantic: false,
        projects: []
      }
    ]

    function fakeSearch(): ReturnType<typeof vi.fn> {
      return vi.fn().mockImplementation((input: RelatedSearchInput) => {
        const ids = input.providerIds
        const wantsLocal = ids === undefined || ids.includes('local')
        const wantsCorpus = ids === undefined || ids.includes('corpus:src1')
        const hits: Array<LocalCaseHit | CorpusDefectHit> = []
        if (wantsLocal) hits.push(hit())
        if (wantsCorpus) hits.push(corpusHit())
        return Promise.resolve({
          query: 'q',
          hits,
          sources: [
            { id: 'local', name: 'Your cases', kind: 'local', ok: true },
            { id: 'corpus:src1', name: 'Hindsight', kind: 'corpus', ok: true }
          ]
        })
      })
    }

    it('unchecking every source sends providerIds: [] and drops every hit shown', async () => {
      const search = fakeSearch()
      ;(window as unknown as { argus: unknown }).argus = {
        related: { search, sources: vi.fn().mockResolvedValue(TWO_SOURCES), defect: vi.fn() }
      }
      render(<RelatedHistoryExplorer caseSlug="current" />)
      expect(await screen.findByText('ECU reset drifts DLT')).toBeInTheDocument()
      expect(screen.getByText(/charge plan dropped/)).toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Search Your cases'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
      fireEvent.click(screen.getByLabelText('Search Hindsight'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(3))

      const last = search.mock.calls[2][0] as RelatedSearchInput
      expect(last.providerIds).toEqual([])

      await waitFor(() =>
        expect(screen.queryByText('ECU reset drifts DLT')).not.toBeInTheDocument()
      )
      expect(screen.queryByText(/charge plan dropped/)).not.toBeInTheDocument()
    })

    it('keeps local in providerIds when only a corpus is unchecked, with includeOpenCases on', async () => {
      // `sources()` (the probe) never lists `local` here — gated closed-only,
      // nothing closed yet — so the rail only learns local exists from a
      // completed search's health once include-open makes it searchable.
      const CORPORA_ONLY: RelatedSourceInfo[] = [
        {
          id: 'corpus:a',
          name: 'Corpus A',
          kind: 'corpus',
          ok: true,
          semantic: false,
          projects: []
        },
        {
          id: 'corpus:b',
          name: 'Corpus B',
          kind: 'corpus',
          ok: true,
          semantic: false,
          projects: []
        }
      ]
      const search = vi.fn().mockResolvedValue({
        query: 'q',
        hits: [],
        sources: [
          { id: 'local', name: 'Your cases', kind: 'local', ok: true },
          { id: 'corpus:a', name: 'Corpus A', kind: 'corpus', ok: true },
          { id: 'corpus:b', name: 'Corpus B', kind: 'corpus', ok: true }
        ]
      })
      ;(window as unknown as { argus: unknown }).argus = {
        related: { search, sources: vi.fn().mockResolvedValue(CORPORA_ONLY), defect: vi.fn() }
      }
      render(<RelatedHistoryExplorer caseSlug="current" />)
      await waitFor(() => expect(search).toHaveBeenCalledTimes(1))

      fireEvent.click(screen.getByLabelText('Include open cases'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(2))

      // The rail only shows a "local" checkbox at all because of Important 2's
      // union fix; this also implicitly covers that the row exists.
      expect(screen.getByLabelText('Search Your cases')).toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Search Corpus B'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(3))

      const last = search.mock.calls[2][0] as RelatedSearchInput
      expect(last.providerIds).toEqual(expect.arrayContaining(['local']))
      expect(last.providerIds).not.toEqual(expect.arrayContaining(['corpus:b']))
    })
  })

  // Important 1: the previous fix (above) only ever exercised a `search` mock
  // that reports the SAME full health every round regardless of `providerIds`
  // — it never reproduced the real service's actual behaviour, which is to
  // report health only for providers that survived the filter. These tests
  // use a `search` mock that narrows `sources` to `providerIds` (when set),
  // which is what actually makes a health-only row disappear once excluded.
  describe('the rail survives a provider dropping out of a single round', () => {
    const ALL_IDS = ['local', 'corpus:a', 'corpus:b']
    const NAMES: Record<string, string> = {
      local: 'Your cases',
      'corpus:a': 'Corpus A',
      'corpus:b': 'Corpus B'
    }
    // `local` is deliberately absent from the probe — the realistic case
    // (spec: `sources()` mirrors only the default fan-out gate) where the
    // rail's only knowledge of a provider comes from search health.
    const PROBE: RelatedSourceInfo[] = [
      { id: 'corpus:a', name: 'Corpus A', kind: 'corpus', ok: true, semantic: false, projects: [] },
      { id: 'corpus:b', name: 'Corpus B', kind: 'corpus', ok: true, semantic: false, projects: [] }
    ]

    function realisticSearch(): ReturnType<typeof vi.fn> {
      return vi.fn().mockImplementation((input: RelatedSearchInput) => {
        const ids = input.providerIds ?? ALL_IDS
        const survivors = ALL_IDS.filter((id) => ids.includes(id))
        return Promise.resolve({
          query: 'q',
          hits: [],
          sources: survivors.map((id) => ({
            id,
            name: NAMES[id],
            kind: id === 'local' ? 'local' : 'corpus',
            ok: true
          })),
          ...(survivors.length === 0 ? { reason: 'no-providers' as const } : {})
        })
      })
    }

    it('keeps a health-only row present, and re-checkable, after it is excluded from the fan-out', async () => {
      const search = realisticSearch()
      ;(window as unknown as { argus: unknown }).argus = {
        related: { search, sources: vi.fn().mockResolvedValue(PROBE), defect: vi.fn() }
      }
      render(<RelatedHistoryExplorer caseSlug="current" />)
      // First round: nothing excluded yet, so local's health-only row exists.
      expect(await screen.findByLabelText('Search Your cases')).toBeInTheDocument()

      // Uncheck it — the NEXT response's health genuinely omits `local` now
      // (the real service's own behaviour), which is exactly what used to
      // erase the row.
      fireEvent.click(screen.getByLabelText('Search Your cases'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
      expect(search.mock.calls[1][0].providerIds).not.toEqual(expect.arrayContaining(['local']))

      // The row must still be there...
      expect(screen.getByLabelText('Search Your cases')).toBeInTheDocument()

      // Also uncheck a probe-listed source, so `excluded` stays non-empty
      // after `local` is re-checked below — otherwise `providerIds` would go
      // back to `undefined` (nothing excluded at all) and prove nothing about
      // whether `local` specifically survived.
      fireEvent.click(screen.getByLabelText('Search Corpus A'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(3))

      // ...and re-checking it must bring `local` back into the fan-out. Before
      // the fix, the row was gone, so there was no control left to click, and
      // `local` would have stayed silently excluded forever.
      fireEvent.click(screen.getByLabelText('Search Your cases'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(4))
      const last = search.mock.calls[3][0] as RelatedSearchInput
      expect(last.providerIds).toEqual(expect.arrayContaining(['local']))
      expect(last.providerIds).not.toEqual(expect.arrayContaining(['corpus:a']))
    })

    it('does not claim "No searchable sources" once every known source is unchecked', async () => {
      const search = realisticSearch()
      ;(window as unknown as { argus: unknown }).argus = {
        related: { search, sources: vi.fn().mockResolvedValue(PROBE), defect: vi.fn() }
      }
      render(<RelatedHistoryExplorer caseSlug="current" />)
      await screen.findByLabelText('Search Your cases')

      fireEvent.click(screen.getByLabelText('Search Your cases'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
      fireEvent.click(screen.getByLabelText('Search Corpus A'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(3))
      fireEvent.click(screen.getByLabelText('Search Corpus B'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(4))

      // A genuine no-providers response — every id really was dropped this
      // round — is exactly the case that used to empty `railRows()`.
      expect(search.mock.calls[3][0].providerIds).toEqual([])
      expect(screen.queryByText(/No searchable sources/i)).not.toBeInTheDocument()
      expect(screen.getByLabelText('Search Your cases')).toBeInTheDocument()
      expect(screen.getByLabelText('Search Corpus A')).toBeInTheDocument()
      expect(screen.getByLabelText('Search Corpus B')).toBeInTheDocument()
    })

    it('keeps a health-only row in the rail through a later failed request', async () => {
      const search = vi.fn()
      search.mockResolvedValueOnce({
        query: 'q',
        hits: [],
        sources: [
          { id: 'corpus:a', name: 'Corpus A', kind: 'corpus', ok: true },
          { id: 'local', name: 'Your cases', kind: 'local', ok: true }
        ]
      })
      search.mockRejectedValueOnce(new Error('fetch failed'))
      ;(window as unknown as { argus: unknown }).argus = {
        related: {
          search,
          sources: vi.fn().mockResolvedValue([PROBE[0]]),
          defect: vi.fn()
        }
      }
      render(<RelatedHistoryExplorer caseSlug="current" />)
      expect(await screen.findByLabelText('Search Your cases')).toBeInTheDocument()

      fireEvent.change(screen.getByLabelText('Search related history'), {
        target: { value: 'battery soc' }
      })
      fireEvent.submit(screen.getByRole('search'))
      await screen.findByText('fetch failed')

      // Before the fix, `health` (read from `shown`, which is null on error)
      // went blank, taking the health-only row with it even though nothing
      // about `local` actually changed.
      expect(screen.getByLabelText('Search Your cases')).toBeInTheDocument()
    })
  })

  // Important 1 (second wave): the previous wave's fix above made stickiness
  // never shrink at all — correct for an EXCLUDED id (never in
  // `providerIds`), wrong for an id the request genuinely had the chance to
  // report and didn't. These pin the fixed rule: evict only when the
  // request could have spoken to the id and the response stayed silent.
  describe('a sticky id clears once a request that could have reported it does not', () => {
    it('clears the synthetic "related-history" row after a healthy round', async () => {
      const search = vi.fn()
      search.mockResolvedValueOnce({
        query: 'q',
        hits: [],
        sources: [
          {
            id: 'related-history',
            name: 'Related history',
            kind: 'service',
            ok: false,
            error: 'SQLITE_BUSY'
          }
        ]
      })
      search.mockResolvedValueOnce({
        query: 'q',
        hits: [],
        sources: [{ id: 'local', name: 'Your cases', kind: 'local', ok: true }]
      })
      ;(window as unknown as { argus: unknown }).argus = {
        related: { search, sources: vi.fn().mockResolvedValue(SOURCES), defect: vi.fn() }
      }
      render(<RelatedHistoryExplorer caseSlug="current" />)
      // The synthetic service failure shows up as a normal rail row, error
      // and all — this is the pre-fix baseline the next round must clear.
      expect(await screen.findByText('SQLITE_BUSY')).toBeInTheDocument()
      expect(screen.getByLabelText('Search Related history')).toBeInTheDocument()

      fireEvent.change(screen.getByLabelText('Search related history'), {
        target: { value: 'battery soc' }
      })
      fireEvent.submit(screen.getByRole('search'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(2))

      await waitFor(() => expect(screen.queryByText('SQLITE_BUSY')).not.toBeInTheDocument())
      expect(screen.queryByLabelText('Search Related history')).not.toBeInTheDocument()
    })

    it('stops listing a provider once it genuinely leaves the fan-out (includeOpen on, then off)', async () => {
      // Realistic shape: local only answers while `includeOpenCases` is set
      // (e.g. nothing closed yet), so toggling it back off makes main's own
      // provider list drop local — the response's `sources` genuinely omits
      // it, exactly like a corpus removed from settings.
      const search = vi.fn().mockImplementation((input: RelatedSearchInput) => {
        const withLocal = input.includeOpenCases === true
        return Promise.resolve({
          query: 'q',
          hits: [],
          sources: withLocal ? [{ id: 'local', name: 'Your cases', kind: 'local', ok: true }] : [],
          ...(withLocal ? {} : { reason: 'no-providers' as const })
        })
      })
      ;(window as unknown as { argus: unknown }).argus = {
        related: { search, sources: vi.fn().mockResolvedValue([]), defect: vi.fn() }
      }
      render(<RelatedHistoryExplorer caseSlug="current" />)
      await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
      expect(screen.queryByLabelText('Search Your cases')).not.toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Include open cases'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
      expect(await screen.findByLabelText('Search Your cases')).toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Include open cases'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(3))
      await waitFor(() =>
        expect(screen.queryByLabelText('Search Your cases')).not.toBeInTheDocument()
      )
    })

    // The property the fix must NOT regress — already exercised in depth by
    // 'the rail survives a provider dropping out of a single round' above,
    // which continues to pass unmodified after this fix (a user-excluded id
    // is never in `providerIds`, so `evictStale` never touches it). This is
    // a focused, standalone repeat of just that guarantee.
    it('keeps a user-excluded row (and its ability to be re-checked) through a round that omits it from health', async () => {
      const ALL_IDS = ['local', 'corpus:a']
      const search = vi.fn().mockImplementation((input: RelatedSearchInput) => {
        const ids = input.providerIds ?? ALL_IDS
        const survivors = ALL_IDS.filter((id) => ids.includes(id))
        return Promise.resolve({
          query: 'q',
          hits: [],
          sources: survivors.map((id) => ({
            id,
            name: id === 'local' ? 'Your cases' : 'Corpus A',
            kind: id === 'local' ? 'local' : 'corpus',
            ok: true
          }))
        })
      })
      ;(window as unknown as { argus: unknown }).argus = {
        related: {
          search,
          sources: vi.fn().mockResolvedValue([
            {
              id: 'corpus:a',
              name: 'Corpus A',
              kind: 'corpus',
              ok: true,
              semantic: false,
              projects: []
            }
          ]),
          defect: vi.fn()
        }
      }
      render(<RelatedHistoryExplorer caseSlug="current" />)
      expect(await screen.findByLabelText('Search Your cases')).toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Search Your cases'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
      expect(search.mock.calls[1][0].providerIds).not.toEqual(expect.arrayContaining(['local']))

      // Still there, and still checkable, even though this round's health
      // said nothing about it at all.
      expect(screen.getByLabelText('Search Your cases')).toBeInTheDocument()

      // Also exclude the other source, so `excluded` stays non-empty after
      // `local` is re-checked below — otherwise `providerIds` would go back
      // to `undefined` (nothing excluded at all) and prove nothing about
      // whether `local` specifically made it back in.
      fireEvent.click(screen.getByLabelText('Search Corpus A'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(3))

      fireEvent.click(screen.getByLabelText('Search Your cases'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(4))
      const last = search.mock.calls[3][0] as RelatedSearchInput
      expect(last.providerIds).toEqual(expect.arrayContaining(['local']))
      expect(last.providerIds).not.toEqual(expect.arrayContaining(['corpus:a']))
    })
  })

  // Critical: `evictStale` cannot tell a pre-fan-out early exit apart from a
  // real "none of these providers exist" answer just by looking at an empty
  // `sources` array — both `query-too-generic` (returned before
  // `RelatedHistoryService.search` ever calls `this.providers(...)`) and the
  // service catch-all's synthetic single `kind: 'service'` entry are NOT
  // evidence about any real provider, unlike a genuine `no-providers` (which
  // is only returned after the provider list is computed).
  describe('a pre-fan-out response is not evidence about any provider', () => {
    it('does not resurrect a stale probe error for a provider a prior search already reported healthy', async () => {
      // The probe says corpus:a is down...
      const PROBE: RelatedSourceInfo[] = [
        {
          id: 'corpus:a',
          name: 'Corpus A',
          kind: 'corpus',
          ok: false,
          error: 'down',
          semantic: false,
          projects: []
        }
      ]
      const search = vi.fn()
      // ...a later (case-composed) search reports it healthy...
      search.mockResolvedValueOnce({
        query: 'seeded',
        hits: [],
        sources: [{ id: 'corpus:a', name: 'Corpus A', kind: 'corpus', ok: true }]
      })
      // ...then the user clears the box and searches again: main's zero-term
      // guard fires before it ever looks at corpus:a.
      search.mockResolvedValueOnce({
        query: '',
        hits: [],
        sources: [],
        reason: 'query-too-generic'
      })
      ;(window as unknown as { argus: unknown }).argus = {
        related: { search, sources: vi.fn().mockResolvedValue(PROBE), defect: vi.fn() }
      }
      render(<RelatedHistoryExplorer caseSlug="current" />)
      await waitFor(() => expect(search).toHaveBeenCalledTimes(1))

      // The healthy search result overrides the probe's stale error.
      expect(screen.getByLabelText('Search Corpus A')).toBeInTheDocument()
      expect(screen.queryByText('down')).not.toBeInTheDocument()

      fireEvent.change(screen.getByLabelText('Search related history'), {
        target: { value: '' }
      })
      fireEvent.submit(screen.getByRole('search'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(2))

      // The query-too-generic round never evaluated corpus:a — its healthy
      // status must survive, not fall back to the probe's stale error.
      expect(screen.getByLabelText('Search Corpus A')).toBeInTheDocument()
      expect(screen.queryByText('down')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    })

    it('does not permanently drop a health-only provider out of the providerIds union (with a source excluded)', async () => {
      // `local` is health-only (absent from the probe), same as the
      // "survives a provider dropping out" fixtures above.
      const PROBE: RelatedSourceInfo[] = [
        {
          id: 'corpus:a',
          name: 'Corpus A',
          kind: 'corpus',
          ok: true,
          semantic: false,
          projects: []
        },
        {
          id: 'corpus:b',
          name: 'Corpus B',
          kind: 'corpus',
          ok: true,
          semantic: false,
          projects: []
        }
      ]
      const search = vi.fn()
      // Round 1: case-composed, nothing excluded — local's health-only row
      // appears.
      search.mockResolvedValueOnce({
        query: 'seeded',
        hits: [],
        sources: [
          { id: 'local', name: 'Your cases', kind: 'local', ok: true },
          { id: 'corpus:a', name: 'Corpus A', kind: 'corpus', ok: true },
          { id: 'corpus:b', name: 'Corpus B', kind: 'corpus', ok: true }
        ]
      })
      // Round 2: user excludes corpus:b.
      search.mockResolvedValueOnce({
        query: 'seeded',
        hits: [],
        sources: [
          { id: 'local', name: 'Your cases', kind: 'local', ok: true },
          { id: 'corpus:a', name: 'Corpus A', kind: 'corpus', ok: true }
        ]
      })
      // Round 3: user clears the box — query-too-generic, sources: [],
      // computed before providers() ever ran.
      search.mockResolvedValueOnce({
        query: '',
        hits: [],
        sources: [],
        reason: 'query-too-generic'
      })
      // Round 4+: capture the outgoing providerIds.
      search.mockResolvedValue({ query: 'y', hits: [], sources: [] })
      ;(window as unknown as { argus: unknown }).argus = {
        related: { search, sources: vi.fn().mockResolvedValue(PROBE), defect: vi.fn() }
      }
      render(<RelatedHistoryExplorer caseSlug="current" />)
      await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
      expect(screen.getByLabelText('Search Your cases')).toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Search Corpus B'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(2))

      fireEvent.change(screen.getByLabelText('Search related history'), {
        target: { value: '' }
      })
      fireEvent.submit(screen.getByRole('search'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(3))

      // local's row must survive the pre-fan-out round...
      expect(screen.getByLabelText('Search Your cases')).toBeInTheDocument()

      // ...and the NEXT round's own request must still ask for it — this is
      // the permanent failure mode: once evicted here, no rail row remains
      // to re-check it, and main never searches it again.
      fireEvent.change(screen.getByLabelText('Search related history'), {
        target: { value: 'y' }
      })
      fireEvent.submit(screen.getByRole('search'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(4))
      const last = search.mock.calls[3][0] as RelatedSearchInput
      expect(last.providerIds).toEqual(expect.arrayContaining(['local']))
      expect(last.providerIds).not.toEqual(expect.arrayContaining(['corpus:b']))
    })

    // Guardrail: the asymmetry the fix relies on — a REAL `no-providers` is
    // returned only after the provider list is computed, so it must keep
    // evicting exactly as before. This is the same mechanism already pinned
    // by 'stops listing a provider once it genuinely leaves the fan-out'
    // above; repeated here, focused, as a regression guard on the new
    // `preFanOut` guard specifically (so a future broadening of that guard
    // to also swallow `no-providers` gets caught here).
    it('still evicts on a genuine no-providers round (computed after the provider list, not before)', async () => {
      const search = vi.fn().mockImplementation((input: RelatedSearchInput) => {
        const withLocal = input.includeOpenCases === true
        return Promise.resolve({
          query: 'q',
          hits: [],
          sources: withLocal ? [{ id: 'local', name: 'Your cases', kind: 'local', ok: true }] : [],
          ...(withLocal ? {} : { reason: 'no-providers' as const })
        })
      })
      ;(window as unknown as { argus: unknown }).argus = {
        related: { search, sources: vi.fn().mockResolvedValue([]), defect: vi.fn() }
      }
      render(<RelatedHistoryExplorer caseSlug="current" />)
      await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
      expect(screen.queryByLabelText('Search Your cases')).not.toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Include open cases'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
      expect(await screen.findByLabelText('Search Your cases')).toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Include open cases'))
      await waitFor(() => expect(search).toHaveBeenCalledTimes(3))
      await waitFor(() =>
        expect(screen.queryByLabelText('Search Your cases')).not.toBeInTheDocument()
      )
    })
  })

  // Test-quality item 1: the probe-side self-heal in the `related:sources`
  // effect (the `base = s.some(...) ? prev : prev.filter(...)` branch) had no
  // test asserting the CLEARING direction — only the no-op "no service row
  // present" branch was ever exercised, implicitly, by every other test's
  // first successful probe.
  it('clears a stale synthetic service row from the probe once a later probe succeeds', async () => {
    const sources = vi.fn()
    sources.mockResolvedValueOnce([
      {
        id: 'related-history',
        name: 'Related history',
        kind: 'service',
        ok: false,
        error: 'boom',
        semantic: false,
        projects: []
      }
    ])
    sources.mockResolvedValueOnce(SOURCES)
    const search = vi.fn().mockResolvedValue({ query: 'q', hits: [], sources: [] })
    ;(window as unknown as { argus: unknown }).argus = {
      related: { search, sources, defect: vi.fn() }
    }
    render(<RelatedHistoryExplorer caseSlug="current" />)
    expect(await screen.findByLabelText('Search Related history')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(sources).toHaveBeenCalledTimes(2))

    await waitFor(() =>
      expect(screen.queryByLabelText('Search Related history')).not.toBeInTheDocument()
    )
    expect(await screen.findByLabelText('Search Your cases')).toBeInTheDocument()
  })

  // Minor 3: the fresh-install case (nothing configured at all) must not
  // tell the user to "Check a source in the rail" when the rail itself,
  // correctly, has nothing to check.
  it('Minor 3: distinguishes nothing-configured from everything-unchecked in the no-providers copy', async () => {
    setArgus({ query: 'q', hits: [], sources: [], reason: 'no-providers' }, [])
    render(<RelatedHistoryExplorer caseSlug="current" />)
    expect(await screen.findByText(/No sources are configured/)).toBeInTheDocument()
    expect(screen.queryByText(/No sources are selected/)).not.toBeInTheDocument()
  })
})

/** Same `search`/`sources` shape as `setArgus` above, extended with a resolved
 *  `defect` — these tests select a corpus hit, which mounts `HitDetail` and
 *  fires its own `related.defect` fetch; an unmocked call there returns
 *  `undefined`, and `.then`-ing that throws synchronously instead of failing
 *  the assertions these tests actually care about — and `attachEvidence`,
 *  which `setArgus` never needed because nothing before increment 3 rendered
 *  the actions that call it.
 */
function setArgusWithActions(
  result: Partial<RelatedSearchResult>,
  sources: RelatedSourceInfo[] = SOURCES
): { search: ReturnType<typeof vi.fn>; attachEvidence: ReturnType<typeof vi.fn> } {
  const search = vi.fn().mockResolvedValue({ query: 'q', hits: [], sources: [], ...result })
  const defect = vi.fn().mockResolvedValue({ ok: false, error: 'not fetched in this test' })
  const attachEvidence = vi.fn().mockResolvedValue({
    ok: true,
    deduped: false,
    record: { id: 1, relPath: 'evidence/KAN-5.md', origin: 'corpus' }
  })
  ;(window as unknown as { argus: unknown }).argus = {
    related: { search, sources: vi.fn().mockResolvedValue(sources), defect, attachEvidence }
  }
  return { search, attachEvidence }
}

describe('RelatedHistoryExplorer — pull into the case', () => {
  it('renders the actions in the case-scoped entry point', async () => {
    setArgusWithActions({ hits: [corpusHit()] })
    render(<RelatedHistoryExplorer caseSlug="NAV-100" sessionId={7} />)
    fireEvent.click(await screen.findByText(/KAN-5/))
    expect(await screen.findByRole('button', { name: /reference in chat/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /attach as evidence/i })).toBeInTheDocument()
  })

  it('renders none of them standalone', async () => {
    setArgusWithActions({ hits: [corpusHit()] })
    render(<RelatedHistoryExplorer />)
    fireEvent.change(screen.getByLabelText('Search related history'), {
      target: { value: 'charge plan' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click(await screen.findByText(/KAN-5/))
    expect(screen.queryByRole('button', { name: /reference in chat/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /attach as evidence/i })).not.toBeInTheDocument()
  })

  it('closes the modal once a citation is staged, so the composer it filled is visible', async () => {
    setArgusWithActions({ hits: [corpusHit()] })
    const onClose = vi.fn()
    render(<RelatedHistoryExplorerModal caseSlug="NAV-100" sessionId={7} onClose={onClose} />)
    fireEvent.click(await screen.findByText(/KAN-5/))
    fireEvent.click(screen.getByRole('button', { name: /reference in chat/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves the modal open after an attach, which reports inline', async () => {
    setArgusWithActions({ hits: [corpusHit()] })
    const onClose = vi.fn()
    render(<RelatedHistoryExplorerModal caseSlug="NAV-100" sessionId={7} onClose={onClose} />)
    fireEvent.click(await screen.findByText(/KAN-5/))
    fireEvent.click(screen.getByRole('button', { name: /attach as evidence/i }))
    await waitFor(() => expect(screen.getByText(/attached as/i)).toBeInTheDocument())
    expect(onClose).not.toHaveBeenCalled()
  })
})
