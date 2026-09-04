// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useDistillProgress } from '../distillJob'
import type { DistillProgress } from '../../../../shared/distill'

const progress = (over: Partial<DistillProgress>): DistillProgress => ({
  jobId: 1,
  caseSlug: 'c1',
  at: 'x',
  phase: 'dossier',
  ...over
})

describe('useDistillProgress', () => {
  it('ignores a broadcast for another jobId', () => {
    let cb: ((p: DistillProgress) => void) | undefined
    ;(window as unknown as { argus: unknown }).argus = {
      distill: {
        onProgress: vi.fn((c: (p: DistillProgress) => void) => {
          cb = c
          return () => undefined
        })
      }
    }
    const { result } = renderHook(() => useDistillProgress(1))
    act(() => cb!(progress({ jobId: 2, phase: 'veto' })))
    expect(result.current).toBeNull()

    act(() => cb!(progress({ jobId: 1, phase: 'veto' })))
    expect(result.current?.phase).toBe('veto')
  })

  it('resets to null when jobId changes', () => {
    let cb: ((p: DistillProgress) => void) | undefined
    ;(window as unknown as { argus: unknown }).argus = {
      distill: {
        onProgress: vi.fn((c: (p: DistillProgress) => void) => {
          cb = c
          return () => undefined
        })
      }
    }
    const { result, rerender } = renderHook(({ jobId }) => useDistillProgress(jobId), {
      initialProps: { jobId: 1 }
    })
    act(() => cb!(progress({ jobId: 1 })))
    expect(result.current).not.toBeNull()

    rerender({ jobId: 2 })
    expect(result.current).toBeNull()
  })

  it("calls the subscription's unsubscribe on unmount", () => {
    const off = vi.fn()
    ;(window as unknown as { argus: unknown }).argus = {
      distill: {
        onProgress: vi.fn(() => off)
      }
    }
    const { unmount } = renderHook(() => useDistillProgress(1))
    expect(off).not.toHaveBeenCalled()

    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
