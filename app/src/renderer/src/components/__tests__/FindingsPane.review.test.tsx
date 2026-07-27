// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
    mode: 'investigation',
    ...over
  }
}

const list = vi.fn()

beforeEach(() => {
  list.mockReset()
  window.argus = {
    findings: { list, review: vi.fn(), clear: vi.fn() },
    cases: { readFindings: vi.fn().mockResolvedValue('') }
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
    render(<FindingsPane slug="c1" sessionId={1} onCite={vi.fn()} />)
    expect(await screen.findByText('Correctness')).toBeInTheDocument()
    expect(screen.getByText('major')).toBeInTheDocument()
  })

  it('shows no flavor badges on an investigation finding', async () => {
    list.mockResolvedValue([row({ id: 1, summary: 'Root cause' })])
    render(<FindingsPane slug="c1" sessionId={1} onCite={vi.fn()} />)
    expect(await screen.findByText('Root cause')).toBeInTheDocument()
    expect(screen.queryByText('major')).not.toBeInTheDocument()
  })

  it('orders critical before major before minor, ahead of unflavored findings', async () => {
    list.mockResolvedValue([
      row({ id: 1, summary: 'minor one', layer: 'tests', severity: 'minor', mode: 'review' }),
      row({ id: 2, summary: 'plain triage' }),
      row({
        id: 3,
        summary: 'critical one',
        layer: 'security',
        severity: 'critical',
        mode: 'review'
      })
    ])
    render(<FindingsPane slug="c1" sessionId={1} onCite={vi.fn()} />)
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
    render(<FindingsPane slug="c1" sessionId={1} onCite={vi.fn()} />)
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
    render(<FindingsPane slug="c1" sessionId={1} onCite={vi.fn()} />)
    await screen.findByText('sec finding')
    expect(screen.queryByRole('button', { name: /filter · tests/i })).not.toBeInTheDocument()
  })
})
