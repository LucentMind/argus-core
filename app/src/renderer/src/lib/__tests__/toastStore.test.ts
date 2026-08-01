import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { toastStore, toast, TOAST_TTL_MS } from '../toastStore'

beforeEach(() => {
  vi.useFakeTimers()
  toastStore.reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('toastStore', () => {
  it('auto-dismisses a toast after its TTL', () => {
    toast('Exported NN-5187')
    expect(toastStore.get().toasts).toHaveLength(1)
    vi.advanceTimersByTime(TOAST_TTL_MS)
    expect(toastStore.get().toasts).toHaveLength(0)
  })

  it('drops the oldest beyond the cap instead of stacking', () => {
    toast('one')
    toast('two')
    toast('three')
    toast('four')
    expect(toastStore.get().toasts.map((t) => t.message)).toEqual(['two', 'three', 'four'])
  })

  it('dismiss removes only the named toast and notifies subscribers', () => {
    toast('keep me')
    toast('drop me')
    const [keep, drop] = toastStore.get().toasts
    const seen = vi.fn()
    const off = toastStore.subscribe(seen)
    toastStore.dismiss(drop.id)
    expect(seen).toHaveBeenCalled()
    expect(toastStore.get().toasts.map((t) => t.id)).toEqual([keep.id])
    off()
  })

  it('reset cancels pending timers so a later advance cannot fire into the next test', () => {
    toast('leaked')
    toastStore.reset()
    expect(toastStore.get().toasts).toHaveLength(0)
    vi.advanceTimersByTime(TOAST_TTL_MS * 3)
    expect(toastStore.get().toasts).toHaveLength(0)
  })

  it('carries the tone through to the queued toast', () => {
    toast('sync failed', 'danger')
    expect(toastStore.get().toasts[0].tone).toBe('danger')
  })
})
