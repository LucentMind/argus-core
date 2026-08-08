import { describe, it, expect, vi, beforeEach } from 'vitest'
import { viewTitleStore } from '../viewTitleStore'

beforeEach(() => {
  viewTitleStore.reset()
})

describe('viewTitleStore', () => {
  it('starts empty — the header shows nothing outside Settings', () => {
    expect(viewTitleStore.get()).toBeNull()
  })

  it('publishes a page and notifies', () => {
    const cb = vi.fn()
    viewTitleStore.subscribe(cb)
    viewTitleStore.publish({ label: 'General', blurb: 'Appearance.' })
    expect(viewTitleStore.get()).toEqual({ label: 'General', blurb: 'Appearance.' })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when both fields are unchanged — get() identity must stay stable', () => {
    viewTitleStore.publish({ label: 'General', blurb: 'Appearance.' })
    const first = viewTitleStore.get()
    const cb = vi.fn()
    viewTitleStore.subscribe(cb)
    viewTitleStore.publish({ label: 'General', blurb: 'Appearance.' })
    // Same identity, no notify: useSyncExternalStore re-renders on identity change, and
    // SettingsView publishes from an effect that runs on every render — a fresh object each
    // time is an infinite render loop, not just wasted work.
    expect(viewTitleStore.get()).toBe(first)
    expect(cb).not.toHaveBeenCalled()
  })

  it('notifies when only the blurb changes', () => {
    viewTitleStore.publish({ label: 'General', blurb: 'Appearance.' })
    const cb = vi.fn()
    viewTitleStore.subscribe(cb)
    viewTitleStore.publish({ label: 'General', blurb: 'Something else.' })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('clears', () => {
    viewTitleStore.publish({ label: 'General', blurb: 'Appearance.' })
    const cb = vi.fn()
    viewTitleStore.subscribe(cb)
    viewTitleStore.publish(null)
    expect(viewTitleStore.get()).toBeNull()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('clearing an already-clear store does not notify', () => {
    const cb = vi.fn()
    viewTitleStore.subscribe(cb)
    viewTitleStore.publish(null)
    expect(cb).not.toHaveBeenCalled()
  })

  it('unsubscribes', () => {
    const cb = vi.fn()
    const off = viewTitleStore.subscribe(cb)
    off()
    viewTitleStore.publish({ label: 'Agent', blurb: 'Providers.' })
    expect(cb).not.toHaveBeenCalled()
  })
})
