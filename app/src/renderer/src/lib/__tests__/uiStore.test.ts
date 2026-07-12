// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { UiStore, FINDINGS_MIN_WIDTH, FINDINGS_MAX_WIDTH, uiStore } from '../uiStore'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('UiStore', () => {
  it('defaults to dark and stamps data-theme on the document at construction', () => {
    new UiStore()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('toggleTheme flips the attribute and persists across instances', () => {
    const store = new UiStore()
    store.toggleTheme()
    expect(store.get().theme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(new UiStore().get().theme).toBe('light')
  })

  it('persists showToolCalls (default true)', () => {
    const store = new UiStore()
    expect(store.get().showToolCalls).toBe(true)
    store.toggleToolCalls()
    expect(store.get().showToolCalls).toBe(false)
    expect(new UiStore().get().showToolCalls).toBe(false)
  })

  it('clamps and persists findings width, persists collapsed', () => {
    const store = new UiStore()
    store.setFindingsWidth(50)
    expect(store.get().findingsWidth).toBe(FINDINGS_MIN_WIDTH)
    store.setFindingsWidth(9999)
    expect(store.get().findingsWidth).toBe(FINDINGS_MAX_WIDTH)
    store.setFindingsWidth(300)
    store.setFindingsCollapsed(true)
    const fresh = new UiStore()
    expect(fresh.get().findingsWidth).toBe(300)
    expect(fresh.get().findingsCollapsed).toBe(true)
  })

  it('recentTabs dedupe, close, and no persistence across restarts', () => {
    const store = new UiStore()
    store.openTab('NAV-1')
    store.openTab('NAV-2')
    store.openTab('NAV-1')
    expect(store.get().recentTabs).toEqual(['NAV-1', 'NAV-2'])
    store.closeTab('NAV-1')
    expect(store.get().recentTabs).toEqual(['NAV-2'])
    expect(new UiStore().get().recentTabs).toEqual([])
  })

  it('notifies subscribers on change', () => {
    const store = new UiStore()
    let n = 0
    const off = store.subscribe(() => n++)
    store.openTab('NAV-1')
    store.toggleTheme()
    off()
    store.toggleTheme()
    expect(n).toBe(2)
  })

  it('setTheme pushes the theme to open panels', () => {
    const setTheme = vi.fn(async () => undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).argus = { ui: { setZoomFactor: vi.fn() }, panels: { setTheme } }
    uiStore.setTheme('light')
    expect(setTheme).toHaveBeenCalledWith('light')
  })
})
