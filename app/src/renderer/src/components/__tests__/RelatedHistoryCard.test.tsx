// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { RelatedHistoryCard } from '../RelatedHistoryCard'
import type {
  CorpusDefectHit,
  LocalCaseHit,
  RelatedSearchResult
} from '../../../../shared/relatedHistory'

const localHit = (over: Partial<LocalCaseHit> = {}): LocalCaseHit => ({
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
  matchedOn: 'semantic',
  rank: 1,
  fusedScore: 0.016,
  status: { label: 'Done / Fixed', tone: 'resolved' },
  distilled: null,
  ...over
})

function setArgus(result: Partial<RelatedSearchResult> | Error): void {
  const search =
    result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue({ query: 'q', hits: [], sources: [], ...result })
  ;(window as unknown as { argus: unknown }).argus = { related: { search } }
}

beforeEach(() => {
  localStorage.clear()
})

describe('RelatedHistoryCard', () => {
  it('renders one merged list under a single heading', async () => {
    setArgus({ hits: [localHit(), corpusHit()] })
    render(<RelatedHistoryCard slug="new" />)
    await screen.findByText(/Related history/i)
    expect(screen.getByText('ECU reset drifts DLT')).toBeInTheDocument()
    expect(screen.getByText(/charge plan dropped/)).toBeInTheDocument()
    expect(screen.queryByText(/Similar past cases/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Known defects/i)).not.toBeInTheDocument()
  })

  it('renders nothing with no hits and every source healthy', async () => {
    setArgus({ hits: [], sources: [{ id: 'local', name: 'Your cases', kind: 'local', ok: true }] })
    render(<RelatedHistoryCard slug="new" />)
    await waitFor(() => expect(screen.queryByText(/Related history/i)).not.toBeInTheDocument())
  })

  it('STILL renders the degraded line when a source failed and there are zero hits', async () => {
    // An outage must never render as blank — that is indistinguishable from
    // "nothing similar", the failure mode this whole feature exists to end.
    setArgus({
      hits: [],
      sources: [
        { id: 'local', name: 'Your cases', kind: 'local', ok: true },
        { id: 'corpus:src1', name: 'Hindsight', kind: 'corpus', ok: false, error: 'fetch failed' }
      ]
    })
    render(<RelatedHistoryCard slug="new" />)
    expect(await screen.findByText(/Hindsight unavailable/i)).toBeInTheDocument()
  })

  it('shows a provenance chip per hit and both on a merged row', async () => {
    setArgus({
      hits: [
        localHit({
          jiraKey: 'KAN-5',
          corpusRef: { sourceId: 'src1', key: 'KAN-5', url: 'https://corpus.example/browse/KAN-5' },
          provenance: [
            { providerId: 'local', providerName: 'Your cases', kind: 'local' },
            { providerId: 'corpus:src1', providerName: 'Hindsight', kind: 'corpus' }
          ]
        })
      ]
    })
    render(<RelatedHistoryCard slug="new" />)
    await screen.findByText('Your cases')
    expect(screen.getByText('Hindsight')).toBeInTheDocument()
  })

  it('opens a local case on click and links a corpus hit out', async () => {
    const onOpenCase = vi.fn()
    setArgus({ hits: [localHit(), corpusHit()] })
    render(<RelatedHistoryCard slug="new" onOpenCase={onOpenCase} />)
    fireEvent.click(await screen.findByRole('button', { name: /ECU reset drifts DLT/ }))
    expect(onOpenCase).toHaveBeenCalledWith('old')
    expect(screen.getByRole('link', { name: /charge plan dropped/ })).toHaveAttribute(
      'href',
      'https://corpus.example/browse/KAN-5'
    )
  })

  it('renders a non-http corpus url as inert text, never an anchor', async () => {
    setArgus({
      hits: [
        corpusHit({ url: 'javascript:alert(1)', title: 'evil one' }),
        corpusHit({
          id: 'corpus:src1:KAN-6',
          key: 'KAN-6',
          url: 'file:///etc/passwd',
          title: 'evil two'
        })
      ]
    })
    render(<RelatedHistoryCard slug="new" />)
    await screen.findByText(/evil one/)
    expect(screen.queryByRole('link', { name: /evil one/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /evil two/ })).not.toBeInTheDocument()
  })

  it('expands a row to reveal distilled root cause and fix', async () => {
    setArgus({
      hits: [
        localHit({
          distilled: {
            signature: 'sig',
            symptoms: 'sym',
            rootCause: 'clock resync',
            fix: 'ignore first 2s',
            terms: ['dlt']
          }
        })
      ]
    })
    render(<RelatedHistoryCard slug="new" />)
    const toggle = await screen.findByRole('button', { name: /details for ECU reset drifts DLT/i })
    expect(screen.queryByText('clock resync')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getByText('clock resync')).toBeInTheDocument()
    expect(screen.getByText('ignore first 2s')).toBeInTheDocument()
  })

  it('names a failed source and still renders healthy hits', async () => {
    setArgus({
      hits: [localHit()],
      sources: [
        { id: 'local', name: 'Your cases', kind: 'local', ok: true },
        { id: 'corpus:src1', name: 'Hindsight', kind: 'corpus', ok: false, error: 'fetch failed' }
      ]
    })
    render(<RelatedHistoryCard slug="new" />)
    expect(await screen.findByText(/Hindsight unavailable/i)).toBeInTheDocument()
    expect(screen.getByText('ECU reset drifts DLT')).toBeInTheDocument()
  })

  it('shows no health chrome when every source is healthy', async () => {
    setArgus({
      hits: [localHit()],
      sources: [{ id: 'local', name: 'Your cases', kind: 'local', ok: true }]
    })
    render(<RelatedHistoryCard slug="new" />)
    await screen.findByText('ECU reset drifts DLT')
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument()
  })

  it('dismisses per case and honours both legacy keys', async () => {
    setArgus({ hits: [localHit()] })
    const { unmount } = render(<RelatedHistoryCard slug="new" />)
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }))
    expect(screen.queryByText(/Related history/i)).not.toBeInTheDocument()
    expect(localStorage.getItem('argus:related-dismissed:new')).toBe('1')
    unmount()

    localStorage.clear()
    localStorage.setItem('argus:similar-dismissed:legacy', '1')
    render(<RelatedHistoryCard slug="legacy" />)
    await waitFor(() => expect(screen.queryByText(/Related history/i)).not.toBeInTheDocument())

    localStorage.clear()
    localStorage.setItem('argus:known-defects-dismissed:legacy2', '1')
    render(<RelatedHistoryCard slug="legacy2" />)
    await waitFor(() => expect(screen.queryByText(/Related history/i)).not.toBeInTheDocument())
  })

  it('survives a rejected search without throwing', async () => {
    setArgus(new Error('ipc exploded'))
    render(<RelatedHistoryCard slug="new" />)
    await waitFor(() => expect(screen.queryByText(/Related history/i)).not.toBeInTheDocument())
  })

  // Minor 4: the pre-merge card rendered `KEY — summary (source)`. The merged
  // card dropped the key even though it is on the wire (`hit.key`), leaving no
  // way to tell which ticket a corpus row refers to.
  it('shows the defect key ahead of the summary for a corpus-sourced row', async () => {
    setArgus({ hits: [corpusHit({ key: 'KAN-9', title: 'summary text' })] })
    render(<RelatedHistoryCard slug="new" />)
    expect(await screen.findByText('KAN-9 — summary text')).toBeInTheDocument()
  })

  it('does not prefix a local row with a key', async () => {
    setArgus({ hits: [localHit()] })
    render(<RelatedHistoryCard slug="new" />)
    expect(await screen.findByText('ECU reset drifts DLT')).toBeInTheDocument()
  })

  // Important 3 (partial): spec §7 calls for a matchedOn affordance on semantic
  // hits. This is also the only place `fuse`'s widening of a merged row's
  // matchedOn to 'both' is observable.
  it('shows a semantic marker chip only on rows matched semantically or both', async () => {
    setArgus({
      hits: [
        corpusHit({ id: 'corpus:src1:KAN-1', key: 'KAN-1', title: 'a', matchedOn: 'semantic' }),
        localHit({ id: 'local:b', title: 'b', matchedOn: 'both' }),
        localHit({ id: 'local:c', title: 'c', matchedOn: 'lexical' })
      ]
    })
    render(<RelatedHistoryCard slug="new" />)
    await screen.findByText(/a$/)
    expect(screen.getAllByText('semantic')).toHaveLength(2)
  })

  it('requests only the slug — the renderer never composes the query', async () => {
    setArgus({ hits: [] })
    render(<RelatedHistoryCard slug="new" />)
    const search = (
      window as unknown as { argus: { related: { search: ReturnType<typeof vi.fn> } } }
    ).argus.related.search
    await waitFor(() => expect(search).toHaveBeenCalledWith({ caseSlug: 'new' }))
  })
})
