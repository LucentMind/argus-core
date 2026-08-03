// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { distillMenuLabel, isDistillInFlight, useDistillJob } from '../distillJob'
import type { DistillJobRow, DistillStatusPayload } from '../../../../shared/distill'

const job = (over: Partial<DistillJobRow>): DistillJobRow => ({
  id: 1,
  caseSlug: 'NN-1',
  state: 'done',
  error: null,
  itemCount: null,
  createdAt: 't',
  finishedAt: null,
  ...over
})

describe('distillMenuLabel', () => {
  it('reads Distill when no job has ever run', () => {
    expect(distillMenuLabel(null)).toBe('Distill')
  })

  it('reads Cancel distillation while queued or running', () => {
    expect(distillMenuLabel(job({ state: 'queued' }))).toBe('Cancel distillation')
    expect(distillMenuLabel(job({ state: 'running' }))).toBe('Cancel distillation')
  })

  it('reads Re-distill with the item count when done', () => {
    expect(distillMenuLabel(job({ state: 'done', itemCount: 3 }))).toBe('Re-distill · 3 items')
    expect(distillMenuLabel(job({ state: 'done', itemCount: 0 }))).toBe(
      'Re-distill · nothing to distill'
    )
  })

  it('reads plain Re-distill after a failure or a cancel', () => {
    expect(distillMenuLabel(job({ state: 'failed' }))).toBe('Re-distill')
    expect(distillMenuLabel(job({ state: 'cancelled' }))).toBe('Re-distill')
  })
})

describe('isDistillInFlight', () => {
  it('is true only for queued and running', () => {
    expect(isDistillInFlight(job({ state: 'queued' }))).toBe(true)
    expect(isDistillInFlight(job({ state: 'running' }))).toBe(true)
    expect(isDistillInFlight(job({ state: 'done' }))).toBe(false)
    expect(isDistillInFlight(job({ state: 'cancelled' }))).toBe(false)
    expect(isDistillInFlight(null)).toBe(false)
  })
})

describe('useDistillJob', () => {
  function setup(initial: DistillJobRow | null): {
    onChangedCb: (p: DistillStatusPayload) => void
  } {
    let onChangedCb!: (p: DistillStatusPayload) => void
    ;(window as unknown as { argus: unknown }).argus = {
      distill: {
        status: vi.fn().mockResolvedValue(initial),
        onChanged: vi.fn((cb: (p: DistillStatusPayload) => void) => {
          onChangedCb = cb
          return () => undefined
        })
      }
    }
    return {
      get onChangedCb() {
        return onChangedCb
      }
    }
  }

  it('N2: ignores a broadcast for a lower job id than the one already tracked (regression: reconcile broadcasts out of order — see DistillQueue.enqueue/cancelOtherInFlight)', async () => {
    // Probe-verified: reconcileAndEnqueue's synchronous broadcast order for a running slug is
    // ["2:queued", "1:cancelled"] — the new job's emit() fires before cancelOtherInFlight()
    // cancels the old one. An unconditional last-write-wins hook ends up tracking the OLD
    // cancelled job, hiding the fresher (higher-id) job that is actually queued/running.
    const ctl = setup(job({ id: 1, state: 'running' }))
    const { result } = renderHook(() => useDistillJob('case-a'))
    await waitFor(() => expect(result.current?.id).toBe(1))

    act(() => {
      ctl.onChangedCb({ caseSlug: 'case-a', job: job({ id: 2, state: 'queued' }) })
    })
    expect(result.current?.id).toBe(2)
    expect(result.current?.state).toBe('queued')

    // The stale, lower-id broadcast for job 1 arrives after — must be ignored, not adopted.
    act(() => {
      ctl.onChangedCb({ caseSlug: 'case-a', job: job({ id: 1, state: 'cancelled' }) })
    })
    expect(result.current?.id).toBe(2)
    expect(result.current?.state).toBe('queued')
  })

  it('N2: adopts the first broadcast when nothing is tracked yet, regardless of id', async () => {
    const ctl = setup(null)
    const { result } = renderHook(() => useDistillJob('case-a'))
    await waitFor(() => expect(window.argus.distill.status).toHaveBeenCalled())
    expect(result.current).toBeNull()

    act(() => {
      ctl.onChangedCb({ caseSlug: 'case-a', job: job({ id: 5, state: 'running' }) })
    })
    expect(result.current?.id).toBe(5)
  })

  it('N2: a null broadcast payload still clears the tracked job', async () => {
    const ctl = setup(job({ id: 3, state: 'running' }))
    const { result } = renderHook(() => useDistillJob('case-a'))
    await waitFor(() => expect(result.current?.id).toBe(3))

    act(() => {
      ctl.onChangedCb({ caseSlug: 'case-a', job: null })
    })
    expect(result.current).toBeNull()
  })

  it('N2: a broadcast with an equal or higher id is adopted normally (same-job update, or a genuinely newer job)', async () => {
    const ctl = setup(job({ id: 1, state: 'queued' }))
    const { result } = renderHook(() => useDistillJob('case-a'))
    await waitFor(() => expect(result.current?.id).toBe(1))

    act(() => {
      ctl.onChangedCb({ caseSlug: 'case-a', job: job({ id: 1, state: 'running' }) })
    })
    expect(result.current?.state).toBe('running')

    act(() => {
      ctl.onChangedCb({ caseSlug: 'case-a', job: job({ id: 4, state: 'done' }) })
    })
    expect(result.current?.id).toBe(4)
  })
})
