// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { DistillChip } from '../DistillChip'
import type { DistillJobRow } from '../../../../shared/distill'
import type { DistillProgress, DistillStatusPayload } from '../../../../shared/distill'

const job = (over: Partial<DistillJobRow>): DistillJobRow => ({
  id: 1,
  caseSlug: 'c1',
  state: 'done',
  error: null,
  itemCount: 3,
  createdAt: 't',
  finishedAt: 't',
  costUsd: null,
  turnCount: null,
  toolCallCount: null,
  promptChars: null,
  dryRun: false,
  ...over
})

let retry: ReturnType<typeof vi.fn>
let cancel: ReturnType<typeof vi.fn>
let progressCb: ((p: DistillProgress) => void) | undefined
function setup(j: DistillJobRow | null): ReturnType<typeof render> {
  retry = vi.fn().mockResolvedValue(job({ state: 'queued' }))
  cancel = vi.fn().mockResolvedValue(job({ state: 'cancelled' }))
  progressCb = undefined
  ;(window as unknown as { argus: unknown }).argus = {
    distill: {
      status: vi.fn().mockResolvedValue(j),
      retry,
      cancel,
      onChanged: vi.fn().mockReturnValue(() => undefined),
      onProgress: vi.fn((cb: (p: DistillProgress) => void) => {
        progressCb = cb
        return () => undefined
      })
    }
  }
  return render(<DistillChip slug="c1" />)
}

describe('DistillChip', () => {
  it('renders nothing once distillation is done — that state lives in the menu now', async () => {
    setup(job({ state: 'done', itemCount: 12 }))
    await waitFor(() => expect(window.argus.distill.status).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/distill/i)).not.toBeInTheDocument())
  })
  it('renders nothing for a done job with nothing staged either — also lives in the menu now', async () => {
    setup(job({ state: 'done', itemCount: 0 }))
    await waitFor(() => expect(window.argus.distill.status).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/distill/i)).not.toBeInTheDocument())
  })

  it('labels an in-flight dry run as a dry run, not a distillation', async () => {
    setup(job({ state: 'running', dryRun: true }))
    await waitFor(() => expect(window.argus.distill.status).toHaveBeenCalled())
    expect(await screen.findByText(/dry run…/)).toBeInTheDocument()
  })

  it('shows the live phase line while running, and the plain label before any progress lands', async () => {
    setup(job({ id: 5, state: 'running', itemCount: null }))
    expect(await screen.findByText('distilling… ✕')).toBeInTheDocument()
    act(() =>
      progressCb!({
        jobId: 5,
        caseSlug: 'c1',
        at: 'x',
        phase: 'materialize',
        detail: 'android-sdk-log-patterns'
      })
    )
    expect(
      screen.getByText('distilling · materializing android-sdk-log-patterns ✕')
    ).toBeInTheDocument()
    act(() => progressCb!({ jobId: 6, caseSlug: 'c1', at: 'x', phase: 'dossier' }))
    expect(
      screen.getByText('distilling · materializing android-sdk-log-patterns ✕')
    ).toBeInTheDocument()
  })

  it('a dry run reads "dry run · …"', async () => {
    setup(job({ id: 5, state: 'running', itemCount: null, dryRun: true }))
    await screen.findByText('dry run… ✕')
    act(() => progressCb!({ jobId: 5, caseSlug: 'c1', at: 'x', phase: 'dossier', toolCalls: 2 }))
    expect(screen.getByText('dry run · dossier · 2 tool calls ✕')).toBeInTheDocument()
  })

  it('F2: renders no resting state for a FAILED dry run — the case\'s real distillation may be fine, only the comparison run failed (regression: the loud red "distill failed — retry" chip rendered for a case whose real distillation was untouched)', async () => {
    setup(job({ state: 'failed', dryRun: true, error: 'boom', itemCount: null }))
    await waitFor(() => expect(window.argus.distill.status).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/distill/i)).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  it('failed state offers retry', async () => {
    setup(job({ state: 'failed', error: 'boom', itemCount: null }))
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }))
    await waitFor(() => expect(retry).toHaveBeenCalledWith(1))
  })

  it('a failed capHit job shows the turns/tool-calls/cost readout beside retry', async () => {
    setup(
      job({
        state: 'failed',
        error: 'cap hit',
        itemCount: null,
        turnCount: 8,
        toolCallCount: 20,
        costUsd: 1.5
      })
    )
    await screen.findByRole('button', { name: /retry/i })
    expect(screen.getByText('8 turns · 20 tool calls · $1.50')).toBeInTheDocument()
  })

  it('a failed job with no recorded usage (pre-v2, or failed before any tokens spent) shows no readout', async () => {
    setup(job({ state: 'failed', error: 'boom', itemCount: null }))
    await screen.findByRole('button', { name: /retry/i })
    expect(screen.queryByText(/turns/)).not.toBeInTheDocument()
    expect(screen.queryByText(/tool calls/)).not.toBeInTheDocument()
  })
  it('renders nothing when no job exists', async () => {
    setup(null)
    await waitFor(() =>
      expect(
        (window as never as { argus: { distill: { status: unknown } } }).argus.distill.status
      ).toHaveBeenCalled()
    )
    expect(screen.queryByText(/distill/i)).not.toBeInTheDocument()
  })

  it('disables retry button while retry promise is pending', async () => {
    let resolveRetry: (value: DistillJobRow) => void
    const retryPromise = new Promise<DistillJobRow>((resolve) => {
      resolveRetry = resolve
    })
    retry.mockReturnValue(retryPromise)
    setup(job({ state: 'failed', error: 'boom', itemCount: null }))
    const button = await screen.findByRole('button', { name: /retry/i })

    fireEvent.click(button)
    await waitFor(() => expect(button).toBeDisabled())

    resolveRetry!(job({ state: 'queued' }))
    // After successful retry, the component transitions from failed state to queued state
    // and shows 'distilling…' instead of the button
    await waitFor(() => expect(screen.getByText(/distilling/)).toBeInTheDocument())
  })

  it('rejected retry re-syncs from status without unhandled rejection', async () => {
    const status = vi
      .fn()
      .mockResolvedValue(job({ state: 'failed', error: 'boom', itemCount: null }))
    retry
      .mockRejectedValueOnce(new Error('job not found'))
      .mockResolvedValue(job({ state: 'queued' }))
    ;(window as unknown as { argus: unknown }).argus = {
      distill: {
        status,
        retry,
        onChanged: vi.fn().mockReturnValue(() => undefined)
      }
    }
    render(<DistillChip slug="c1" />)
    const button = await screen.findByRole('button', { name: /retry/i })
    expect(status).toHaveBeenCalledWith('c1')

    // After first click, status call count should increase as we re-sync
    const initialStatusCallCount = (status as ReturnType<typeof vi.fn>).mock.calls.length
    fireEvent.click(button)
    await waitFor(() => expect(retry).toHaveBeenCalledWith(1))
    // On failure, status() is called again to re-sync
    await waitFor(() => expect(status).toHaveBeenCalledTimes(initialStatusCallCount + 1))
  })

  it('a later broadcast supersedes an optimistic retry result (regression: override never cleared)', async () => {
    let onChangedCb: ((p: DistillStatusPayload) => void) | undefined
    retry = vi.fn().mockResolvedValue(job({ state: 'queued' }))
    ;(window as unknown as { argus: unknown }).argus = {
      distill: {
        status: vi.fn().mockResolvedValue(job({ state: 'failed', error: 'boom', itemCount: null })),
        retry,
        onChanged: vi.fn((cb: (p: DistillStatusPayload) => void) => {
          onChangedCb = cb
          return () => undefined
        }),
        onProgress: vi.fn(() => () => undefined)
      }
    }
    render(<DistillChip slug="c1" />)
    const button = await screen.findByRole('button', { name: /retry/i })

    fireEvent.click(button)
    await waitFor(() => expect(retry).toHaveBeenCalledWith(1))
    // Optimistic retry result lands: chip shows distilling…
    await waitFor(() => expect(screen.getByText(/distilling/)).toBeInTheDocument())

    // Main finishes the job and broadcasts `done` — this must supersede the optimistic
    // 'queued' result the retry response set, not be permanently shadowed by it.
    act(() => {
      onChangedCb?.({ caseSlug: 'c1', job: job({ state: 'done', itemCount: 5 }) })
    })

    await waitFor(() => expect(screen.queryByText(/distill/i)).not.toBeInTheDocument())
  })

  it('F6: a stale optimistic retry result must not make the ✕ cancel the wrong job (regression)', async () => {
    // Both 'queued' and 'running' render the identical "distilling… ✕" chip, so a stale retry
    // response landing over a newer job's row is invisible in the label — the only observable
    // symptom is which job id the ✕ actually cancels. That is what this test pins.
    let onChangedCb: ((p: DistillStatusPayload) => void) | undefined
    let resolveRetry: (value: DistillJobRow) => void
    const retryPromise = new Promise<DistillJobRow>((resolve) => {
      resolveRetry = resolve
    })
    retry = vi.fn().mockReturnValue(retryPromise)
    cancel = vi.fn().mockResolvedValue(job({ id: 2, state: 'cancelled' }))
    ;(window as unknown as { argus: unknown }).argus = {
      distill: {
        status: vi
          .fn()
          .mockResolvedValue(job({ id: 1, state: 'failed', error: 'boom', itemCount: null })),
        retry,
        cancel,
        onChanged: vi.fn((cb: (p: DistillStatusPayload) => void) => {
          onChangedCb = cb
          return () => undefined
        }),
        onProgress: vi.fn(() => () => undefined)
      }
    }
    render(<DistillChip slug="c1" />)
    const button = await screen.findByRole('button', { name: /retry/i })

    fireEvent.click(button)
    expect(retry).toHaveBeenCalledWith(1)

    // Before job A's retry response reaches the renderer, a broadcast for job B (a fresh
    // re-distill on the same slug, e.g. from the case-actions menu) lands and starts running.
    act(() => {
      onChangedCb?.({ caseSlug: 'c1', job: job({ id: 2, state: 'running', itemCount: null }) })
    })
    const chip = await waitFor(() => screen.getByRole('button', { name: /^cancel distillation$/i }))

    // Job A's stale retry response now resolves as 'queued'. Must not be adopted over job B's
    // row.
    await act(async () => {
      resolveRetry!(job({ id: 1, state: 'queued', itemCount: null }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    fireEvent.click(chip)
    expect(cancel).toHaveBeenCalledWith(2) // the genuinely running job, not the stale job 1
  })

  it('cancels the run when the running chip is clicked', async () => {
    setup(job({ state: 'running', itemCount: null }))
    const chip = await screen.findByRole('button', { name: /^cancel distillation$/i })
    fireEvent.click(chip)
    expect(cancel).toHaveBeenCalledWith(1)
    await waitFor(() => expect(screen.getByText(/cancelling…/i)).toBeInTheDocument())
  })

  it('renders nothing for a cancelled job — it is a resting state', async () => {
    // Starts from a genuinely visible `running` chip, then delivers `cancelled` through the
    // broadcast (not the initial fetch): a pre-fetch render also satisfies "no /distill/i
    // text", so asserting straight from a cancelled `status()` result can't tell "cancelled
    // correctly fell through to `return null`" apart from "never advanced past the initial
    // empty render". Routing the transition through `onChanged` rules that out.
    let onChangedCb: ((p: DistillStatusPayload) => void) | undefined
    ;(window as unknown as { argus: unknown }).argus = {
      distill: {
        status: vi.fn().mockResolvedValue(job({ state: 'running', itemCount: null })),
        retry: vi.fn(),
        cancel: vi.fn(),
        onChanged: vi.fn((cb: (p: DistillStatusPayload) => void) => {
          onChangedCb = cb
          return () => undefined
        }),
        onProgress: vi.fn(() => () => undefined)
      }
    }
    render(<DistillChip slug="c1" />)
    await screen.findByRole('button', { name: /^cancel distillation$/i })

    act(() => {
      onChangedCb?.({ caseSlug: 'c1', job: job({ state: 'cancelled', itemCount: null }) })
    })

    await waitFor(() => expect(screen.queryByText(/distill/i)).not.toBeInTheDocument())
  })

  it('a later broadcast for a newer job supersedes a stale optimistic cancel result (regression: stale cancel response hides the newer job)', async () => {
    let onChangedCb: ((p: DistillStatusPayload) => void) | undefined
    let resolveCancel: (value: DistillJobRow) => void
    const cancelPromise = new Promise<DistillJobRow>((resolve) => {
      resolveCancel = resolve
    })
    cancel = vi.fn().mockReturnValue(cancelPromise)
    ;(window as unknown as { argus: unknown }).argus = {
      distill: {
        status: vi.fn().mockResolvedValue(job({ id: 1, state: 'running', itemCount: null })),
        retry: vi.fn(),
        cancel,
        onChanged: vi.fn((cb: (p: DistillStatusPayload) => void) => {
          onChangedCb = cb
          return () => undefined
        }),
        onProgress: vi.fn(() => () => undefined)
      }
    }
    render(<DistillChip slug="c1" />)
    const chip = await screen.findByRole('button', { name: /^cancel distillation$/i })

    fireEvent.click(chip)
    expect(cancel).toHaveBeenCalledWith(1)
    await waitFor(() => expect(screen.getByText(/cancelling…/i)).toBeInTheDocument())

    // Before job A's cancel response reaches the renderer, a re-distill starts job B on the
    // same slug and B's `running` broadcast lands — the chip must switch to show B.
    act(() => {
      onChangedCb?.({ caseSlug: 'c1', job: job({ id: 2, state: 'running', itemCount: null }) })
    })
    await waitFor(() => expect(screen.getByText(/distilling/i)).toBeInTheDocument())

    // Job A's stale cancel response now resolves. It must not overwrite job B's chip with a
    // `cancelled` row that matches no render branch — which would make the chip vanish even
    // though job B is genuinely still running.
    await act(async () => {
      resolveCancel!(job({ id: 1, state: 'cancelled', itemCount: null }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByText(/distilling/i)).toBeInTheDocument()
  })
})
