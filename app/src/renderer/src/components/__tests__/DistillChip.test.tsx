// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { DistillChip } from '../DistillChip'
import type { DistillJobRow } from '../../../../shared/distill'
import type { DistillStatusPayload } from '../../../../shared/distill'

const job = (over: Partial<DistillJobRow>): DistillJobRow => ({
  id: 1,
  caseSlug: 'c1',
  state: 'done',
  error: null,
  itemCount: 3,
  createdAt: 't',
  finishedAt: 't',
  ...over
})

let retry: ReturnType<typeof vi.fn>
let cancel: ReturnType<typeof vi.fn>
function setup(j: DistillJobRow | null): ReturnType<typeof render> {
  retry = vi.fn().mockResolvedValue(job({ state: 'queued' }))
  cancel = vi.fn().mockResolvedValue(job({ state: 'cancelled' }))
  ;(window as unknown as { argus: unknown }).argus = {
    distill: {
      status: vi.fn().mockResolvedValue(j),
      retry,
      cancel,
      onChanged: vi.fn().mockReturnValue(() => undefined)
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
  it('failed state offers retry', async () => {
    setup(job({ state: 'failed', error: 'boom', itemCount: null }))
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }))
    await waitFor(() => expect(retry).toHaveBeenCalledWith(1))
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
        })
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
        })
      }
    }
    render(<DistillChip slug="c1" />)
    await screen.findByRole('button', { name: /^cancel distillation$/i })

    act(() => {
      onChangedCb?.({ caseSlug: 'c1', job: job({ state: 'cancelled', itemCount: null }) })
    })

    await waitFor(() => expect(screen.queryByText(/distill/i)).not.toBeInTheDocument())
  })
})
