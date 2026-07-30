// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { UiStore, FINDINGS_MIN_WIDTH, FINDINGS_MAX_WIDTH, uiStore } from '../uiStore'

/** Captures the `ui:theme-changed` subscriber so a test can play main's broadcast. */
let pushTheme: ((theme: 'dark' | 'light') => void) | null = null

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  pushTheme = null
  window.argus = {
    ui: {
      setZoomFactor: vi.fn(),
      onThemeChanged: (cb: (t: 'dark' | 'light') => void) => {
        pushTheme = cb
        return () => {
          pushTheme = null
        }
      }
    },
    panels: { setTheme: vi.fn() }
  } as never
})

describe('UiStore cross-window theme', () => {
  it('adopts a theme change broadcast from another window', () => {
    const store = new UiStore()
    expect(store.get().theme).toBe('dark')

    pushTheme!('light')

    expect(store.get().theme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('notifies subscribers so React re-renders on a broadcast', () => {
    const store = new UiStore()
    const seen = vi.fn()
    store.subscribe(seen)

    pushTheme!('light')

    expect(seen).toHaveBeenCalled()
  })

  it('does not re-broadcast an adopted theme, so two windows cannot ping-pong', () => {
    const store = new UiStore()
    vi.mocked(window.argus.panels.setTheme).mockClear()

    pushTheme!('light')

    expect(window.argus.panels.setTheme).not.toHaveBeenCalled()
    expect(store.get().theme).toBe('light')
  })

  it('leaves persistence to the window that originated the change', () => {
    new UiStore()
    pushTheme!('light')
    // The originating window already wrote it; a receiver writing too would race on
    // shared localStorage and could resurrect a stale value.
    expect(localStorage.getItem('argus.ui.theme')).toBeNull()
  })
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

  // The editor window's import graph never reaches App, so nothing there constructs a UiStore.
  // It calls this instead (editor.tsx) — theme.css puts the dark tokens on bare `:root`, so a
  // missing data-theme is a black window for a light-theme user, and the zoom factor is a
  // per-renderer webFrame setting that has to be re-applied in every window.
  it('applyToDocument re-applies the persisted theme and zoom to a fresh document', () => {
    localStorage.setItem('argus.ui.theme', 'light')
    localStorage.setItem('argus.ui.uiScale', '1.25')
    const setZoomFactor = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).argus = { ui: { setZoomFactor } }
    const store = new UiStore()

    document.documentElement.removeAttribute('data-theme')
    setZoomFactor.mockClear()
    store.applyToDocument()

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(setZoomFactor).toHaveBeenCalledWith(1.25)
  })

  it('setTheme pushes the theme to open panels', () => {
    const setTheme = vi.fn(async () => undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).argus = { ui: { setZoomFactor: vi.fn() }, panels: { setTheme } }
    uiStore.setTheme('light')
    expect(setTheme).toHaveBeenCalledWith('light')
  })
})

describe('evidenceCollapsed', () => {
  it('defaults to false, persists, and survives a reload', () => {
    localStorage.removeItem('argus.ui.evidenceCollapsed')
    const store = new UiStore()
    expect(store.get().evidenceCollapsed).toBe(false)

    store.setEvidenceCollapsed(true)
    expect(store.get().evidenceCollapsed).toBe(true)
    expect(localStorage.getItem('argus.ui.evidenceCollapsed')).toBe('true')

    const fresh = new UiStore()
    expect(fresh.get().evidenceCollapsed).toBe(true)
  })
})
