// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { RoutineInbox } from '../RoutineInbox'
import { routinesStore } from '../../../lib/routinesStore'
import type { RoutineDef, RoutineRunSummary, RoutinesPayload } from '../../../../../shared/routines'

const sweep: RoutineDef = {
  id: 'sweep',
  name: 'Nightly sweep',
  prompt: 'Sweep the repo',
  timeoutMs: 600_000,
  enabled: true
}

function run(over: Partial<RoutineRunSummary> = {}): RoutineRunSummary {
  return {
    id: 1,
    routineId: 'sweep',
    caseSlug: 'routine-sweep',
    sessionId: 7,
    trigger: 'scheduled',
    status: 'ok',
    startedAt: '2026-08-03T02:00:00.000Z',
    finishedAt: '2026-08-03T02:05:00.000Z',
    summary: 'nothing new',
    error: null,
    reviewedAt: null,
    ...over
  }
}

function payload(over: Partial<RoutinesPayload> = {}): RoutinesPayload {
  return {
    routines: [sweep],
    loadError: null,
    runningId: null,
    queued: [],
    nextRunAt: {},
    unreviewedCount: 1,
    runs: [run()],
    ...over
  }
}

let api: {
  list: ReturnType<typeof vi.fn>
  onChanged: ReturnType<typeof vi.fn>
  markReviewed: ReturnType<typeof vi.fn>
  markAllReviewed: ReturnType<typeof vi.fn>
}
let listeners: Array<() => void>

beforeEach(() => {
  listeners = []
  routinesStore.reset()
  api = {
    list: vi.fn(async () => payload()),
    onChanged: vi.fn((cb: () => void) => {
      listeners.push(cb)
      return () => {}
    }),
    markReviewed: vi.fn(async () => payload({ unreviewedCount: 0, runs: [] })),
    markAllReviewed: vi.fn(async () => payload({ unreviewedCount: 0, runs: [] }))
  }
  window.argus = { routines: api } as never
})

describe('RoutineInbox', () => {
  it('renders nothing when there is nothing to review', async () => {
    api.list.mockResolvedValue(payload({ unreviewedCount: 0, runs: [] }))
    const { container } = render(<RoutineInbox onOpen={vi.fn()} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('lists an unreviewed run with its name, trigger and summary', async () => {
    render(<RoutineInbox onOpen={vi.fn()} />)
    expect(await screen.findByText(/Nightly sweep/)).toBeInTheDocument()
    expect(screen.getByTestId('run-trigger-1')).toHaveTextContent('scheduled')
    expect(screen.getByText('nothing new')).toBeInTheDocument()
    expect(screen.getByText(/1 to review/)).toBeInTheDocument()
  })

  it('excludes reviewed and still-running runs', async () => {
    api.list.mockResolvedValue(
      payload({
        unreviewedCount: 1,
        runs: [
          run({ id: 1 }),
          run({ id: 2, summary: 'already seen', reviewedAt: '2026-08-03T09:00:00.000Z' }),
          run({ id: 3, summary: 'in flight', status: 'running', finishedAt: null })
        ]
      })
    )
    render(<RoutineInbox onOpen={vi.fn()} />)
    expect(await screen.findByText('nothing new')).toBeInTheDocument()
    expect(screen.queryByText('already seen')).not.toBeInTheDocument()
    expect(screen.queryByText('in flight')).not.toBeInTheDocument()
  })

  it('marks one run reviewed and drops the section once the payload refreshes', async () => {
    render(<RoutineInbox onOpen={vi.fn()} />)
    await screen.findByText('nothing new')

    api.list.mockResolvedValue(payload({ unreviewedCount: 0, runs: [] }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed · Nightly sweep' }))

    expect(api.markReviewed).toHaveBeenCalledWith(1)
    // The store re-reads on the broadcast, which main emits after the write.
    listeners.forEach((l) => l())
    await waitFor(() => expect(screen.queryByText('nothing new')).not.toBeInTheDocument())
  })

  it('marks every run reviewed and drops the section once the payload refreshes', async () => {
    render(<RoutineInbox onOpen={vi.fn()} />)
    await screen.findByText('nothing new')

    api.list.mockResolvedValue(payload({ unreviewedCount: 0, runs: [] }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark all reviewed' }))

    expect(api.markAllReviewed).toHaveBeenCalled()
    // Same convergence path as the single-mark case: the store re-reads on the broadcast.
    listeners.forEach((l) => l())
    await waitFor(() => expect(screen.queryByText('nothing new')).not.toBeInTheDocument())
  })

  it('opens the case the run wrote to', async () => {
    const onOpen = vi.fn()
    render(<RoutineInbox onOpen={onOpen} />)
    await screen.findByText('nothing new')
    fireEvent.click(screen.getByRole('button', { name: 'Open case · Nightly sweep' }))
    expect(onOpen).toHaveBeenCalledWith('routine-sweep')
  })

  it('marks the clicked row reviewed, not the other pending row', async () => {
    const other: RoutineDef = { ...sweep, id: 'digest', name: 'Morning digest' }
    api.list.mockResolvedValue(
      payload({
        unreviewedCount: 2,
        routines: [sweep, other],
        runs: [run({ id: 1 }), run({ id: 2, routineId: 'digest', summary: 'digest done' })]
      })
    )
    render(<RoutineInbox onOpen={vi.fn()} />)
    await screen.findByText('digest done')

    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed · Morning digest' }))

    expect(api.markReviewed).toHaveBeenCalledWith(2)
    expect(api.markReviewed).not.toHaveBeenCalledWith(1)
  })

  it('surfaces a rejected mark-reviewed instead of leaving the click silent', async () => {
    api.markReviewed.mockRejectedValueOnce(new Error('routine store is locked'))
    render(<RoutineInbox onOpen={vi.fn()} />)
    await screen.findByText('nothing new')

    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed · Nightly sweep' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('routine store is locked')
    // The failed write must not have removed the row — the click did nothing, and the banner
    // is the only thing that is allowed to say so.
    expect(screen.getByText('nothing new')).toBeInTheDocument()
  })

  it('falls back to the raw id when the routine has been deleted', async () => {
    api.list.mockResolvedValue(
      payload({ routines: [], runs: [run({ routineId: 'gone-routine' })] })
    )
    render(<RoutineInbox onOpen={vi.fn()} />)
    expect(await screen.findByText(/gone-routine/)).toBeInTheDocument()
  })

  it('shows a failed run with its error', async () => {
    api.list.mockResolvedValue(
      payload({ runs: [run({ status: 'failed', summary: null, error: 'driver exploded' })] })
    )
    render(<RoutineInbox onOpen={vi.fn()} />)
    expect(await screen.findByText('driver exploded')).toBeInTheDocument()
  })

  it('prints the SQL count, not the number of rows it can show', async () => {
    api.list.mockResolvedValue(payload({ unreviewedCount: 62, runs: [run()] }))
    render(<RoutineInbox onOpen={vi.fn()} />)
    expect(await screen.findByText(/62 to review/)).toBeInTheDocument()
  })
})
