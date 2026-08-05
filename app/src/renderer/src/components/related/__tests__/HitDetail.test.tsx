// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { HitDetail } from '../HitDetail'
import type {
  CorpusDefectHit,
  LocalCaseHit,
  RelatedDefectRecord
} from '../../../../../shared/relatedHistory'

const record = (over: Partial<RelatedDefectRecord> = {}): RelatedDefectRecord => ({
  key: 'KAN-5',
  url: 'https://corpus.example/browse/KAN-5',
  project: 'KAN',
  summary: 'charge plan dropped',
  description: '## Steps\n\nIt drops the plan.',
  status: 'Done',
  resolution: 'Fixed',
  components: ['charging'],
  labels: ['regression'],
  affectsVersions: [],
  fixVersions: ['2.1'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  resolvedAt: '2026-01-03T00:00:00.000Z',
  links: [{ type: 'duplicates', key: 'KAN-9' }],
  commentCount: 1,
  comments: [{ author: 'ana', createdAt: '2026-01-02T00:00:00.000Z', body: 'seen on 2.0 too' }],
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

const localHit = (over: Partial<LocalCaseHit> = {}): LocalCaseHit => ({
  kind: 'local',
  id: 'local:old',
  caseSlug: 'old',
  jiraKey: null,
  provenance: [{ providerId: 'local', providerName: 'Your cases', kind: 'local' }],
  title: 'ECU reset drifts DLT',
  snippet: null,
  matchedOn: 'lexical',
  rank: 1,
  fusedScore: 0.016,
  status: { label: 'solved', tone: 'resolved' },
  distilled: {
    signature: 'ECU reset drifts DLT',
    symptoms: 'timestamps jump',
    rootCause: 'clock resync races the first log write',
    fix: 'ignore the first two seconds after reset',
    terms: ['E_DLT_DRIFT']
  },
  ...over
})

function setDefect(result: unknown): ReturnType<typeof vi.fn> {
  const defect = vi.fn().mockResolvedValue(result)
  ;(window as unknown as { argus: unknown }).argus = { related: { defect } }
  return defect
}

describe('HitDetail', () => {
  it('renders a local hit from data in hand, with no fetch', async () => {
    const defect = setDefect({ ok: true, value: record() })
    render(<HitDetail hit={localHit()} />)
    expect(screen.getByText('clock resync races the first log write')).toBeInTheDocument()
    expect(screen.getByText('E_DLT_DRIFT')).toBeInTheDocument()
    expect(defect).not.toHaveBeenCalled()
  })

  it('opens the case for a local hit', () => {
    setDefect({ ok: true, value: record() })
    const onOpenCase = vi.fn()
    render(<HitDetail hit={localHit()} onOpenCase={onOpenCase} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open case' }))
    expect(onOpenCase).toHaveBeenCalledWith('old')
  })

  it('fetches and renders the full corpus record', async () => {
    const defect = setDefect({ ok: true, value: record() })
    render(<HitDetail hit={corpusHit()} />)
    await waitFor(() => expect(screen.getByText('It drops the plan.')).toBeInTheDocument())
    expect(defect).toHaveBeenCalledWith('src1', 'KAN-5')
    expect(screen.getByText('Done / Fixed')).toBeInTheDocument()
    expect(screen.getByText('charging')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /KAN-5/ })).toHaveAttribute(
      'href',
      'https://corpus.example/browse/KAN-5'
    )
  })

  it('renders a non-http record url as inert text, never an anchor', async () => {
    setDefect({ ok: true, value: record({ url: 'javascript:alert(1)' }) })
    render(<HitDetail hit={corpusHit({ url: 'javascript:alert(1)' })} />)
    await waitFor(() => expect(screen.getByText('charge plan dropped')).toBeInTheDocument())
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('navigates to a linked key in place, using the closed link vocabulary', async () => {
    const defect = setDefect({ ok: true, value: record() })
    render(<HitDetail hit={corpusHit()} />)
    await waitFor(() => expect(screen.getByText('duplicates')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'KAN-9' }))
    await waitFor(() => expect(defect).toHaveBeenLastCalledWith('src1', 'KAN-9'))
  })

  it('shows comments behind a disclosure', async () => {
    setDefect({ ok: true, value: record() })
    render(<HitDetail hit={corpusHit()} />)
    await waitFor(() => expect(screen.getByText(/1 comment/)).toBeInTheDocument())
    const button = screen.getByRole('button', { name: /1 comment/ })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(button)
    expect(screen.getByText('seen on 2.0 too')).toBeInTheDocument()
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })

  it('guards markdown links in the description: dangerous scheme is inert, legitimate link is gated', async () => {
    setDefect({
      ok: true,
      value: record({
        description: '[go](javascript:alert(1)) and [ext](https://evil.example) and plain text'
      })
    })
    render(<HitDetail hit={corpusHit()} />)
    await waitFor(() => expect(screen.getByText(/and plain text/)).toBeInTheDocument())
    // The dangerous-scheme link never becomes an anchor.
    expect(screen.queryByRole('link', { name: 'go' })).not.toBeInTheDocument()
    // The legitimate external link is routed through the guarded window-open
    // path: target=_blank + rel=noreferrer, same as the record's own url.
    const extLink = screen.getByRole('link', { name: 'ext' })
    expect(extLink).toHaveAttribute('href', 'https://evil.example')
    expect(extLink).toHaveAttribute('target', '_blank')
    expect(extLink).toHaveAttribute('rel', 'noreferrer')
    // Surrounding prose still rendered, proving the guard filtered the link
    // rather than the whole markdown block failing to render.
    expect(screen.getByText(/and plain text/)).toBeInTheDocument()
  })

  it('guards markdown links in a comment body the same way', async () => {
    setDefect({
      ok: true,
      value: record({
        comments: [
          {
            author: 'ana',
            createdAt: '2026-01-02T00:00:00.000Z',
            body: 'see [ext](https://evil.example) for details'
          }
        ]
      })
    })
    render(<HitDetail hit={corpusHit()} />)
    await waitFor(() => expect(screen.getByText(/1 comment/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /1 comment/ }))
    const extLink = await screen.findByRole('link', { name: 'ext' })
    expect(extLink).toHaveAttribute('href', 'https://evil.example')
    expect(extLink).toHaveAttribute('target', '_blank')
    expect(extLink).toHaveAttribute('rel', 'noreferrer')
    expect(screen.getByText(/for details/)).toBeInTheDocument()
  })

  it('surfaces a failed fetch instead of rendering an empty pane', async () => {
    setDefect({ ok: false, error: 'HTTP 404', code: 'not_found' })
    render(<HitDetail hit={corpusHit()} />)
    expect(await screen.findByText(/HTTP 404/)).toBeInTheDocument()
  })

  // Smaller fix 3: the wire contract guarantees `commentCount` even when
  // `comments[]` is omitted (a service may legitimately not send bodies). The
  // disclosure must still tell the user there ARE comments, just none in hand
  // to show — not silently disappear because `comments` happens to be empty.
  it('labels the disclosure from commentCount even when comment bodies are omitted', async () => {
    setDefect({ ok: true, value: record({ commentCount: 12, comments: undefined }) })
    render(<HitDetail hit={corpusHit()} />)
    expect(await screen.findByText('12 comments')).toBeInTheDocument()
  })

  it('offers both halves on a merged row', async () => {
    setDefect({ ok: true, value: record() })
    render(
      <HitDetail
        hit={localHit({
          corpusRef: {
            sourceId: 'src1',
            key: 'KAN-5',
            url: 'https://corpus.example/browse/KAN-5'
          }
        })}
      />
    )
    expect(screen.getByRole('button', { name: 'Open case' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('It drops the plan.')).toBeInTheDocument())
  })
})
