import { describe, it, expect, vi, beforeEach } from 'vitest'
import { settingsBarStore } from '../settingsBarStore'

beforeEach(() => {
  settingsBarStore.reset()
})

describe('settingsBarStore', () => {
  it('starts empty — the header shows nothing outside Settings', () => {
    expect(settingsBarStore.get()).toBeNull()
  })

  it('publishes a page and notifies', () => {
    const cb = vi.fn()
    settingsBarStore.subscribe(cb)
    settingsBarStore.publish({ label: 'General', blurb: 'Appearance.' })
    expect(settingsBarStore.get()).toEqual({ label: 'General', blurb: 'Appearance.' })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when both fields are unchanged — get() identity must stay stable', () => {
    settingsBarStore.publish({ label: 'General', blurb: 'Appearance.' })
    const first = settingsBarStore.get()
    const cb = vi.fn()
    settingsBarStore.subscribe(cb)
    settingsBarStore.publish({ label: 'General', blurb: 'Appearance.' })
    // Same identity, no notify: useSyncExternalStore re-renders on identity change, and
    // SettingsView publishes from an effect that runs on every render — a fresh object each
    // time is an infinite render loop, not just wasted work.
    expect(settingsBarStore.get()).toBe(first)
    expect(cb).not.toHaveBeenCalled()
  })

  it('notifies when only the blurb changes', () => {
    settingsBarStore.publish({ label: 'General', blurb: 'Appearance.' })
    const cb = vi.fn()
    settingsBarStore.subscribe(cb)
    settingsBarStore.publish({ label: 'General', blurb: 'Something else.' })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('clears', () => {
    settingsBarStore.publish({ label: 'General', blurb: 'Appearance.' })
    const cb = vi.fn()
    settingsBarStore.subscribe(cb)
    settingsBarStore.publish(null)
    expect(settingsBarStore.get()).toBeNull()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('clearing an already-clear store does not notify', () => {
    const cb = vi.fn()
    settingsBarStore.subscribe(cb)
    settingsBarStore.publish(null)
    expect(cb).not.toHaveBeenCalled()
  })

  it('unsubscribes', () => {
    const cb = vi.fn()
    const off = settingsBarStore.subscribe(cb)
    off()
    settingsBarStore.publish({ label: 'Agent', blurb: 'Providers.' })
    expect(cb).not.toHaveBeenCalled()
  })
})
