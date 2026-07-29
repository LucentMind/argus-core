// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FindingsPane } from '../FindingsPane'
import type { FindingRow } from '../../../../shared/observability'

function row(over: Partial<FindingRow>): FindingRow {
  return {
    id: 1,
    caseId: 1,
    sessionId: 1,
    turnId: null,
    summary: 's',
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
    mode: 'investigation',
    ...over
  }
}

const list = vi.fn()

beforeEach(() => {
  list.mockReset()
  window.argus = {
    findings: { list, review: vi.fn(), clear: vi.fn() },
    cases: { readFindings: vi.fn().mockResolvedValue('') },
    review: { worktreeHead: vi.fn().mockResolvedValue(null) }
  } as never // test double for the preload bridge
})

describe('FindingsPane review flavor', () => {
  it('badges a review finding with its layer and severity', async () => {
    list.mockResolvedValue([
      row({
        id: 1,
        summary: 'Inverted guard',
        layer: 'correctness',
        severity: 'major',
        mode: 'review'
      })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    // A lone present layer still renders its filter chip (Finding 2), whose visible text
    // shares the layer label with the finding's own badge — scope the badge lookup to the
    // finding's list item instead of a page-wide text query that could match either element.
    const item = (await screen.findByText('Inverted guard')).closest('li')
    expect(item).not.toBeNull()
    expect(within(item as HTMLElement).getByText('Correctness')).toBeInTheDocument()
    expect(within(item as HTMLElement).getByText('major')).toBeInTheDocument()
  })

  it('shows no flavor badges on an investigation finding', async () => {
    list.mockResolvedValue([row({ id: 1, summary: 'Root cause' })])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    expect(await screen.findByText('Root cause')).toBeInTheDocument()
    expect(screen.queryByText('major')).not.toBeInTheDocument()
  })

  it('orders critical before major before minor, ahead of unflavored findings', async () => {
    list.mockResolvedValue([
      row({ id: 1, summary: 'minor one', layer: 'tests', severity: 'minor', mode: 'review' }),
      row({ id: 2, summary: 'plain triage', mode: 'review' }),
      row({
        id: 3,
        summary: 'critical one',
        layer: 'security',
        severity: 'critical',
        mode: 'review'
      })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    await screen.findByText('critical one')
    const texts = screen.getAllByRole('listitem').map((li) => li.textContent ?? '')
    expect(texts[0]).toContain('critical one')
    expect(texts[1]).toContain('minor one')
    expect(texts[2]).toContain('plain triage')
  })

  it('filters to one layer and back', async () => {
    list.mockResolvedValue([
      row({ id: 1, summary: 'sec finding', layer: 'security', severity: 'major', mode: 'review' }),
      row({ id: 2, summary: 'test finding', layer: 'tests', severity: 'minor', mode: 'review' })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    await screen.findByText('sec finding')
    await userEvent.click(screen.getByRole('button', { name: /filter · security/i }))
    await waitFor(() => expect(screen.queryByText('test finding')).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /filter · security/i }))
    expect(await screen.findByText('test finding')).toBeInTheDocument()
  })

  it('offers a filter chip only for layers actually present', async () => {
    list.mockResolvedValue([
      row({ id: 1, summary: 'sec finding', layer: 'security', severity: 'major', mode: 'review' })
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    await screen.findByText('sec finding')
    expect(screen.getByRole('button', { name: /filter · security/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /filter · tests/i })).not.toBeInTheDocument()
  })

  it('self-clears a stale layer filter instead of stranding the pane empty', async () => {
    // FindingsPane carries no `key` in CaseWorkspace, so the same instance survives a session
    // switch; only its props change. Filter to a layer, then let the finding set change under
    // it (simulated here via a prop change, since the fetch effect keys on [slug, sessionId,
    // bump]) so that layer no longer exists — the pane must not get stuck on "No findings match
    // this filter." with no control left to clear it.
    list.mockResolvedValueOnce([
      row({ id: 1, summary: 'sec finding', layer: 'security', severity: 'major', mode: 'review' })
    ])
    const { rerender } = render(
      <FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />
    )
    await screen.findByText('sec finding')
    await userEvent.click(screen.getByRole('button', { name: /filter · security/i }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /filter · security/i })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    )

    list.mockResolvedValueOnce([
      row({ id: 2, summary: 'tests finding', layer: 'tests', severity: 'minor', mode: 'review' })
    ])
    rerender(<FindingsPane slug="c1" sessionId={2} activeMode="review" onCite={vi.fn()} />)

    expect(await screen.findByText('tests finding')).toBeInTheDocument()
    expect(screen.queryByText('No findings match this filter.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /filter · security/i })).not.toBeInTheDocument()
  })
})
