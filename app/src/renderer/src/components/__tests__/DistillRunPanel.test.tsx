// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { DistillRunPanel } from '../DistillRunPanel'
import type { DistillJobRow, DistillRunDetail } from '../../../../shared/distill'

const row = (over: Partial<DistillJobRow> = {}): DistillJobRow => ({
  id: 2,
  caseSlug: 'c1',
  state: 'done',
  error: null,
  itemCount: 0,
  createdAt: '2026-08-19T10:00:00.000Z',
  finishedAt: '2026-08-19T10:04:00.000Z',
  costUsd: 0.42,
  turnCount: 14,
  toolCallCount: 13,
  promptChars: 1000,
  dryRun: false,
  ...over
})

const detail = (over: Partial<DistillRunDetail> = {}): DistillRunDetail => ({
  job: row(),
  stages: {
    dossier: { promptHash: 'h1', promptChars: 10, rawOutput: 'DOSSIER RAW OUTPUT' },
    candidates: { promptHash: 'h2', promptChars: 20, rawOutput: 'CANDIDATES RAW', error: 'boom' }
  },
  dropped: [
    { type: 'skill-new', target: 'foo', title: 'Foo', reason: 'duplicate' },
    { type: 'skill-new', target: 'bar', title: 'Bar', reason: 'duplicate' },
    { type: 'skill-edit', target: 'baz', title: 'Baz', reason: 'target-exists' }
  ],
  trajectory: null,
  rawOutput: '{}',
  inputSnapshotChars: 4096,
  ...over
})

function setup(runs: DistillJobRow[], byId: Record<number, DistillRunDetail>): void {
  ;(window as unknown as { argus: unknown }).argus = {
    distill: {
      runs: vi.fn().mockResolvedValue(runs),
      run: vi.fn((id: number) => Promise.resolve(byId[id] ?? null))
    }
  }
}

describe('DistillRunPanel', () => {
  it('shows the verdict line and the drop breakdown for a zero-item run', async () => {
    setup([row()], { 2: detail() })
    render(<DistillRunPanel slug="c1" onClose={() => undefined} />)
    expect(await screen.findByText(/staged 0/)).toBeInTheDocument()
    expect(screen.getByText(/3 candidates dropped/)).toBeInTheDocument()
    expect(screen.getByText(/duplicate ×2/)).toBeInTheDocument()
    expect(screen.getByText(/target-exists ×1/)).toBeInTheDocument()
  })

  it("renders each stage's raw output verbatim", async () => {
    setup([row()], { 2: detail() })
    render(<DistillRunPanel slug="c1" onClose={() => undefined} />)
    expect(await screen.findByText('DOSSIER RAW OUTPUT')).toBeInTheDocument()
    expect(screen.getByText('CANDIDATES RAW')).toBeInTheDocument()
    expect(screen.getByText(/boom/)).toBeInTheDocument()
  })

  it('marks a stage the run never reached', async () => {
    setup([row()], { 2: detail() })
    render(<DistillRunPanel slug="c1" onClose={() => undefined} />)
    await screen.findByText('DOSSIER RAW OUTPUT')
    expect(screen.getByTestId('stage-summary')).toHaveTextContent('not reached')
  })

  it('says staging never ran for a dry run, rather than "staged 0"', async () => {
    const dry = row({ id: 3, dryRun: true, itemCount: null })
    setup([dry], { 3: detail({ job: dry }) })
    render(<DistillRunPanel slug="c1" onClose={() => undefined} />)
    expect(await screen.findByText(/not staged \(dry run\)/)).toBeInTheDocument()
    expect(screen.queryByText(/staged 0/)).not.toBeInTheDocument()
  })

  it('switches runs from the picker and refetches the detail', async () => {
    const older = row({ id: 1, itemCount: 3 })
    setup([row(), older], { 2: detail(), 1: detail({ job: older, stages: null, dropped: [] }) })
    render(<DistillRunPanel slug="c1" onClose={() => undefined} />)
    await screen.findByText('DOSSIER RAW OUTPUT')
    await userEvent.selectOptions(screen.getByLabelText('Run'), '1')
    await waitFor(() => expect(window.argus.distill.run).toHaveBeenCalledWith(1))
    expect(await screen.findByText(/staged 3/)).toBeInTheDocument()
  })

  it('renders an empty state when the case has no runs', async () => {
    setup([], {})
    render(<DistillRunPanel slug="c1" onClose={() => undefined} />)
    expect(await screen.findByText(/never been distilled/i)).toBeInTheDocument()
  })

  // Known hazard (carried forward from the read-path review): readRunDetail guards `dropped`
  // and `trajectory` with Array.isArray but not `stages` — a corrupt-but-valid-JSON stages_json
  // arrives as whatever it parsed to. `detail.stages?.materialize` could be a non-array, and an
  // unguarded `.map()` on that would throw. This is the diagnostic tool for a broken run, so it
  // must survive one.
  it('does not throw when stages parsed to a wrong shape (materialize is not an array)', async () => {
    const corrupt = detail({
      stages: { materialize: 'not-an-array' } as unknown as DistillRunDetail['stages']
    })
    setup([row()], { 2: corrupt })
    render(<DistillRunPanel slug="c1" onClose={() => undefined} />)
    expect(await screen.findByText(/staged 0/)).toBeInTheDocument()
    // No materialize stage block rendered — the corrupt value was dropped, not iterated.
    expect(screen.queryByTestId('stage-materialize-0')).not.toBeInTheDocument()
  })
})
