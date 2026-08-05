// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { HitDetail } from '../HitDetail'
import { composerDraft } from '../../../lib/composerDraft'
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

/** `setDefect` replaces `window.argus` wholesale; this variant keeps both
 *  members of the `related` namespace so the action tests can assert on the
 *  attach call while the detail pane's own fetch still resolves. */
function setRelated(
  defectResult: unknown,
  attachResult: unknown
): { defect: ReturnType<typeof vi.fn>; attachEvidence: ReturnType<typeof vi.fn> } {
  const defect = vi.fn().mockResolvedValue(defectResult)
  const attachEvidence = vi.fn().mockResolvedValue(attachResult)
  ;(window as unknown as { argus: unknown }).argus = { related: { defect, attachEvidence } }
  return { defect, attachEvidence }
}

const okRecord = { ok: true, value: record() }
const okAttach = {
  ok: true,
  deduped: false,
  record: { id: 1, relPath: 'evidence/KAN-5.md', origin: 'corpus' }
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

describe('HitDetail — pull into the case (spec §10)', () => {
  it('renders no action at all without a case', async () => {
    setRelated(okRecord, okAttach)
    render(<HitDetail hit={corpusHit()} />)
    await waitFor(() => expect(screen.getByText('charge plan dropped')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /reference in chat/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /attach as evidence/i })).not.toBeInTheDocument()
  })

  it('stages a citation in the composer for the case+session, and never sends a turn', async () => {
    setRelated(okRecord, okAttach)
    const spy = vi.spyOn(composerDraft, 'set')
    const onReferenced = vi.fn()
    render(
      <HitDetail hit={corpusHit()} caseSlug="NAV-100" sessionId={7} onReferenced={onReferenced} />
    )
    fireEvent.click(screen.getByRole('button', { name: /reference in chat/i }))
    expect(spy).toHaveBeenCalledTimes(1)
    const [slug, session, text] = spy.mock.calls[0]
    expect(slug).toBe('NAV-100')
    expect(session).toBe(7)
    expect(text).toContain('KAN-5')
    expect(onReferenced).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('disables the reference action, with a reason, when the case has no session yet', () => {
    setRelated(okRecord, okAttach)
    render(<HitDetail hit={corpusHit()} caseSlug="NAV-100" sessionId={null} />)
    const btn = screen.getByRole('button', { name: /reference in chat/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', expect.stringMatching(/no chat session/i))
  })

  it('attaches a corpus hit by key and reports the filename', async () => {
    const { attachEvidence } = setRelated(okRecord, okAttach)
    render(<HitDetail hit={corpusHit()} caseSlug="NAV-100" sessionId={7} />)
    fireEvent.click(screen.getByRole('button', { name: /attach as evidence/i }))
    await waitFor(() => expect(screen.getByText(/attached as KAN-5\.md/i)).toBeInTheDocument())
    expect(attachEvidence).toHaveBeenCalledWith('NAV-100', 'src1', 'KAN-5')
  })

  it('says so when the identical snapshot was already attached', async () => {
    setRelated(okRecord, { ...okAttach, deduped: true })
    render(<HitDetail hit={corpusHit()} caseSlug="NAV-100" sessionId={7} />)
    fireEvent.click(screen.getByRole('button', { name: /attach as evidence/i }))
    await waitFor(() => expect(screen.getByText(/already attached/i)).toBeInTheDocument())
  })

  it('surfaces an attach failure inline rather than throwing it away', async () => {
    setRelated(okRecord, { ok: false, error: 'corpus unreachable' })
    render(<HitDetail hit={corpusHit()} caseSlug="NAV-100" sessionId={7} />)
    fireEvent.click(screen.getByRole('button', { name: /attach as evidence/i }))
    await waitFor(() => expect(screen.getByText('corpus unreachable')).toBeInTheDocument())
  })

  it('surfaces a rejected attach call too', async () => {
    const attachEvidence = vi.fn().mockRejectedValue(new Error('ipc died'))
    const defect = vi.fn().mockResolvedValue(okRecord)
    ;(window as unknown as { argus: unknown }).argus = { related: { defect, attachEvidence } }
    render(<HitDetail hit={corpusHit()} caseSlug="NAV-100" sessionId={7} />)
    fireEvent.click(screen.getByRole('button', { name: /attach as evidence/i }))
    await waitFor(() => expect(screen.getByText('ipc died')).toBeInTheDocument())
  })

  it('offers no attach action on a local-only hit, but still offers the citation', () => {
    setRelated(okRecord, okAttach)
    render(<HitDetail hit={localHit()} caseSlug="NAV-100" sessionId={7} />)
    expect(screen.getByRole('button', { name: /reference in chat/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /attach as evidence/i })).not.toBeInTheDocument()
  })

  it('attaches a merged row through its corpus ref', async () => {
    const { attachEvidence } = setRelated(okRecord, okAttach)
    render(
      <HitDetail
        hit={localHit({
          corpusRef: { sourceId: 'src1', key: 'KAN-5', url: 'https://corpus.example/browse/KAN-5' }
        })}
        caseSlug="NAV-100"
        sessionId={7}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /attach as evidence/i }))
    await waitFor(() => expect(attachEvidence).toHaveBeenCalledWith('NAV-100', 'src1', 'KAN-5'))
  })
})
