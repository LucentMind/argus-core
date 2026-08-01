import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { noticeStore, notice, NOTICE_TTL_MS } from '../noticeStore'

beforeEach(() => {
  vi.useFakeTimers()
  noticeStore.reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('noticeStore', () => {
  it('auto-dismisses a notice after its TTL', () => {
    notice('Exported NN-5187')
    expect(noticeStore.get().notices).toHaveLength(1)
    vi.advanceTimersByTime(NOTICE_TTL_MS)
    expect(noticeStore.get().notices).toHaveLength(0)
  })

  it('dismiss removes only the named notice and notifies subscribers', () => {
    notice('keep me')
    notice('drop me')
    const [keep, drop] = noticeStore.get().notices
    const seen = vi.fn()
    const off = noticeStore.subscribe(seen)
    noticeStore.dismiss(drop.id)
    expect(seen).toHaveBeenCalled()
    expect(noticeStore.get().notices.map((n) => n.id)).toEqual([keep.id])
    off()
  })

  it('reset cancels pending timers so a later advance cannot fire into the next test', () => {
    notice('leaked')
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    noticeStore.reset()
    expect(vi.getTimerCount()).toBe(0)
    expect(noticeStore.get().notices).toHaveLength(0)
    vi.advanceTimersByTime(NOTICE_TTL_MS * 3)
    expect(noticeStore.get().notices).toHaveLength(0)
  })

  it('carries the tone through to the queued notice', () => {
    notice('sync failed', 'danger')
    expect(noticeStore.get().notices[0].tone).toBe('danger')
  })
})
