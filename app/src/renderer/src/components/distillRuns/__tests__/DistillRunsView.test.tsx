// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DistillRunsView } from '../DistillRunsView'
import { viewTitleStore } from '../../../lib/viewTitleStore'
import { __resetEscapeLayersForTest } from '../../../lib/escapeLayer'
import type {
  DistillRunListRow,
  DistillRunDetail,
  DistillProgress,
  DistillStatusPayload
} from '../../../../../shared/distill'

const row = (over: Partial<DistillRunListRow>): DistillRunListRow => ({
  id: 1,
  caseSlug: 'a',
  caseTitle: 'Alpha',
  jiraKey: 'NAV-1',
  pipeline: 'v3',
  state: 'done',
  error: null,
  itemCount: 2,
  createdAt: '2026-09-04T13:00:00.000Z',
  finishedAt: '2026-09-04T13:06:00.000Z',
  costUsd: 1,
  turnCount: 1,
  toolCallCount: 1,
  promptChars: 1,
  dryRun: false,
  ...over
})
const detailFor = (r: DistillRunListRow): DistillRunDetail => ({
  job: r,
  pipeline: r.pipeline,
  stages: null,
  dropped: [],
  trajectory: null,
  rawOutput: `RAW ${r.id}`,
  inputSnapshotChars: 5,
  parsed: {
    dossier: null,
    summaryPresent: false,
    summary: null,
    candidates: null,
    materialized: null
  }
})
let onChanged: (p: DistillStatusPayload) => void
let onProgress: (p: DistillProgress) => void
let rows: DistillRunListRow[]
beforeEach(() => {
  __resetEscapeLayersForTest()
  viewTitleStore.reset()
  rows = [
    row({ id: 3, caseSlug: 'b', caseTitle: 'Beta', jiraKey: null, pipeline: 'v2' }),
    row({ id: 2, dryRun: true, itemCount: null }),
    row({ id: 1 })
  ]
  window.argus = {
    distill: {
      runsAll: vi.fn(async () => rows),
      run: vi.fn(async (id: number) => {
        const r = rows.find((x) => x.id === id)
        return r ? detailFor(r) : null
      }),
      onChanged: vi.fn((cb) => {
        onChanged = cb
        return () => {}
      }),
      onProgress: vi.fn((cb) => {
        onProgress = cb
        return () => {}
      }),
      redistill: vi.fn(),
      dryRun: vi.fn(),
      cancel: vi.fn()
    },
    cases: { list: vi.fn(async () => []) }
  } as never
})

describe('DistillRunsView', () => {
  it('lists runs grouped by case, newest group first, and selects the newest run by default', async () => {
    render(<DistillRunsView onClose={() => {}} onOpenCase={() => {}} />)
    const groups = await screen.findAllByTestId('case-group')
    expect(groups[0]).toHaveTextContent('Beta')
    expect(groups[1]).toHaveTextContent('Alpha')
    expect(await screen.findByText('RAW 3')).toBeInTheDocument()
  })
  it('preselects the newest run of initialSlug and filters the rail to that case', async () => {
    render(<DistillRunsView initialSlug="a" onClose={() => {}} onOpenCase={() => {}} />)
    expect(await screen.findByText('RAW 2')).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search cases' })).toHaveValue('a')
  })
  it('filter chips narrow the rail (v2 only)', async () => {
    render(<DistillRunsView onClose={() => {}} onOpenCase={() => {}} />)
    await screen.findAllByTestId('case-group')
    fireEvent.click(screen.getByRole('button', { name: 'Filter v2' }))
    expect(screen.getAllByTestId('run-row')).toHaveLength(1)
  })
  it('compare opens a second column for another run of the same case', async () => {
    const user = userEvent.setup()
    render(<DistillRunsView initialSlug="a" onClose={() => {}} onOpenCase={() => {}} />)
    await screen.findByText('RAW 2')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Compare with' }), '1')
    expect(await screen.findByText('RAW 1')).toBeInTheDocument()
    expect(screen.getByText('RAW 2')).toBeInTheDocument()
    expect(screen.getByTestId('compare-columns')).toBeInTheDocument()
  })
  it('a progress broadcast updates the in-flight row and the strip', async () => {
    rows = [
      row({ id: 9, state: 'running', itemCount: null, costUsd: null }),
      row({ id: 10, caseSlug: 'b', caseTitle: 'Beta', jiraKey: null, state: 'done' })
    ]
    render(<DistillRunsView onClose={() => {}} onOpenCase={() => {}} />)
    await screen.findAllByTestId('run-row')
    act(() =>
      onProgress({
        jobId: 9,
        caseSlug: 'a',
        at: 'x',
        phase: 'dossier',
        toolCalls: 3,
        detail: 'read_transcript s1'
      })
    )
    const runningRow = screen
      .getAllByTestId('run-row')
      .find((el) => el.textContent?.includes('#9'))!
    const doneRow = screen.getAllByTestId('run-row').find((el) => el.textContent?.includes('#10'))!
    expect(runningRow).toHaveTextContent('dossier · 3 tool calls · read_transcript s1')
    expect(screen.getByTestId('strip-dossier').dataset.state).toBe('running')
    expect(runningRow.querySelector('.animate-spin')).toBeInTheDocument()
    expect(doneRow.querySelector('.animate-spin')).not.toBeInTheDocument()
  })
  it('a terminal broadcast refetches the list and the selected run', async () => {
    rows = [row({ id: 9, state: 'running', itemCount: null })]
    render(<DistillRunsView onClose={() => {}} onOpenCase={() => {}} />)
    await screen.findByTestId('run-row')
    rows = [row({ id: 9, state: 'done', itemCount: 4 })]
    act(() => onChanged({ caseSlug: 'a', job: rows[0] }))
    await waitFor(() => expect(screen.getByTestId('run-row')).toHaveTextContent('4 staged'))
    expect(window.argus.distill.run).toHaveBeenCalledTimes(2)
  })
  it('publishes its title and closes on Escape', async () => {
    const onClose = vi.fn()
    render(<DistillRunsView onClose={onClose} onOpenCase={() => {}} />)
    await screen.findAllByTestId('case-group')
    expect(viewTitleStore.get()?.label).toBe('Distillation runs')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
  it('Run again opens the popover pinned to the selected case, and a started job is selected', async () => {
    const user = userEvent.setup()
    ;(window.argus.distill.redistill as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ id: 50, state: 'queued', itemCount: null })
    )
    render(<DistillRunsView initialSlug="a" onClose={() => {}} onOpenCase={() => {}} />)
    await screen.findByText('RAW 2')
    await user.click(screen.getByRole('button', { name: 'Run again' }))
    expect(screen.getByRole('dialog', { name: 'New distillation run' })).toHaveTextContent('a')
    rows = [row({ id: 50, state: 'queued', itemCount: null }), ...rows]
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(window.argus.distill.redistill).toHaveBeenCalledWith('a')
    await waitFor(() => expect(screen.getByTestId('strip-input')).toBeInTheDocument())
    expect(window.argus.distill.run).toHaveBeenLastCalledWith(50)
  })
})
