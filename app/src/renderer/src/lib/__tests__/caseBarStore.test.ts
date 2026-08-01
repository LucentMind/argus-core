import { describe, it, expect, vi, beforeEach } from 'vitest'
import { caseBarStore } from '../caseBarStore'

beforeEach(() => {
  caseBarStore.reset()
})

describe('caseBarStore state', () => {
  it('publishes busy state to subscribers', () => {
    const seen = vi.fn()
    const off = caseBarStore.subscribe(seen)
    caseBarStore.publish({ slug: 'case-a', busyMode: 'review', statusText: 'Searching…' })
    expect(seen).toHaveBeenCalled()
    expect(caseBarStore.get()).toEqual({
      slug: 'case-a',
      busyMode: 'review',
      statusText: 'Searching…'
    })
    off()
  })

  it('keeps the same snapshot object when nothing changed', () => {
    // useSyncExternalStore re-renders on every getSnapshot identity change, and
    // CaseWorkspace publishes on every render — an unstable snapshot is an infinite loop.
    caseBarStore.publish({ slug: 'case-a', busyMode: null, statusText: null })
    const first = caseBarStore.get()
    const seen = vi.fn()
    const off = caseBarStore.subscribe(seen)
    caseBarStore.publish({ slug: 'case-a', busyMode: null, statusText: null })
    expect(caseBarStore.get()).toBe(first)
    expect(seen).not.toHaveBeenCalled()
    off()
  })

  it('stops notifying after unsubscribe', () => {
    const seen = vi.fn()
    const off = caseBarStore.subscribe(seen)
    off()
    caseBarStore.publish({ slug: 'case-b', busyMode: null, statusText: null })
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('caseBarStore events', () => {
  it('delivers a mode switch to a consumer listening for that case', () => {
    const seen = vi.fn()
    const off = caseBarStore.onEventFor('case-a', seen)
    caseBarStore.emit({ kind: 'mode-switched', slug: 'case-a', mode: 'review', sessionId: 7 })
    expect(seen).toHaveBeenCalledWith({
      kind: 'mode-switched',
      slug: 'case-a',
      mode: 'review',
      sessionId: 7
    })
    off()
  })

  it('ignores an event published for a different case', () => {
    // The guard CaseWorkspace's currentSlugRef gives today does not survive a trip through
    // a singleton: without this, a switch resolved for case A would be applied by a
    // workspace that has since moved to case B, retargeting B's active chat.
    const seen = vi.fn()
    const off = caseBarStore.onEventFor('case-b', seen)
    caseBarStore.emit({ kind: 'mode-switched', slug: 'case-a', mode: 'review', sessionId: 7 })
    expect(seen).not.toHaveBeenCalled()
    off()
  })

  it('delivers errors on the same channel', () => {
    const seen = vi.fn()
    const off = caseBarStore.onEventFor('case-a', seen)
    caseBarStore.emit({ kind: 'mode-error', slug: 'case-a', message: 'nope' })
    expect(seen).toHaveBeenCalledWith({ kind: 'mode-error', slug: 'case-a', message: 'nope' })
    off()
  })

  it('stops delivering after unsubscribe', () => {
    const seen = vi.fn()
    const off = caseBarStore.onEventFor('case-a', seen)
    off()
    caseBarStore.emit({ kind: 'mode-error', slug: 'case-a', message: 'nope' })
    expect(seen).not.toHaveBeenCalled()
  })

  it('reset drops both state and event listeners', () => {
    const seen = vi.fn()
    caseBarStore.onEventFor('case-a', seen)
    caseBarStore.publish({ slug: 'case-a', busyMode: 'review', statusText: 'x' })
    caseBarStore.reset()
    caseBarStore.emit({ kind: 'mode-error', slug: 'case-a', message: 'nope' })
    expect(seen).not.toHaveBeenCalled()
    expect(caseBarStore.get()).toEqual({ slug: null, busyMode: null, statusText: null })
  })
})
