// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { RunItemRows } from '../RunItemRows'
import type { RoutineRunItemSummary } from '../../../../../shared/routines'

const item = (over: Partial<RoutineRunItemSummary> = {}): RoutineRunItemSummary => ({
  id: 1,
  runId: 10,
  itemKey: 'ABC-1',
  caseSlug: 'abc-1',
  status: 'processed',
  error: null,
  suggestion: null,
  startedAt: '2026-08-08T02:00:00.000Z',
  finishedAt: '2026-08-08T02:05:00.000Z',
  ...over
})

beforeEach(() => {
  ;(window as never as { argus: unknown }).argus = {
    routines: {
      acceptItem: vi.fn().mockResolvedValue({}),
      dismissItem: vi.fn().mockResolvedValue({})
    }
  }
})

describe('RunItemRows', () => {
  it('renders nothing for a run with no items, so unscoped runs look unchanged', () => {
    const { container } = render(<RunItemRows items={[]} onOpen={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the key and the suggestion', () => {
    render(
      <RunItemRows
        items={[
          item({ suggestion: { title: 'Crash on empty', tags: ['severity:high'], rationale: 'r' } })
        ]}
        onOpen={() => {}}
      />
    )
    expect(screen.getByText('ABC-1')).toBeInTheDocument()
    expect(screen.getByText(/Crash on empty/)).toBeInTheDocument()
    expect(screen.getByText('severity:high')).toBeInTheDocument()
  })

  it('accepts an item', async () => {
    render(<RunItemRows items={[item()]} onOpen={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /Accept · ABC-1/ }))
    expect(window.argus.routines.acceptItem).toHaveBeenCalledWith(1)
  })

  it('disambiguates two items with the SAME key across runs', () => {
    // The inbox's ordinary shape: a nightly routine revisiting one ticket on two nights.
    render(
      <RunItemRows
        items={[item({ id: 1, runId: 10 }), item({ id: 2, runId: 11 })]}
        onOpen={() => {}}
      />
    )
    expect(screen.getAllByRole('button', { name: /^Accept · ABC-1/ })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Accept · ABC-1 · run 10' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept · ABC-1 · run 11' })).toBeInTheDocument()
  })

  it('offers no verbs for a failed item, and shows why it failed', () => {
    render(
      <RunItemRows
        items={[item({ status: 'failed', error: 'ingest 404', caseSlug: null })]}
        onOpen={() => {}}
      />
    )
    expect(screen.getByText(/ingest 404/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument()
  })

  it('offers no verbs for a skipped item', () => {
    render(<RunItemRows items={[item({ status: 'skipped' })]} onOpen={() => {}} />)
    expect(screen.getByText(/skipped/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument()
  })

  it('offers no verbs for a processed item with no caseSlug', () => {
    // Both existing gate tests vary `status` (the `failed` fixture also zeroes `caseSlug`, and
    // `skipped` never touches it) — neither isolates the `caseSlug !== null` half of
    // `canAct = item.status === 'processed' && caseSlug !== null`. Production cannot currently
    // reach `processed` + `caseSlug: null` (a processed item always has a slug attached before
    // `finishRunItem` writes 'processed'), but the type permits it and the gate claims to guard
    // it, so the guard itself needs its own test independent of `status`.
    render(
      <RunItemRows items={[item({ status: 'processed', caseSlug: null })]} onOpen={() => {}} />
    )
    expect(screen.getByText('ABC-1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open case/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument()
  })

  it('dismisses an item with the chosen resolution', async () => {
    // Not in the brief's own test list, but Dismiss is new surface area (Step 3's resolution
    // picker) with no other coverage in this suite — worth one pass through the real click path.
    render(<RunItemRows items={[item()]} onOpen={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss · ABC-1 · run 10' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'rejected' }))
    expect(window.argus.routines.dismissItem).toHaveBeenCalledWith(1, 'rejected')
  })

  it('surfaces a failed accept without clearing the row', async () => {
    ;(window.argus.routines.acceptItem as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('case is gone')
    )
    render(<RunItemRows items={[item()]} onOpen={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /Accept · ABC-1/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('case is gone'))
    expect(screen.getByText('ABC-1')).toBeInTheDocument()
  })
})
