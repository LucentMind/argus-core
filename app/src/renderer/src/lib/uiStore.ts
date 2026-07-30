export type Theme = 'dark' | 'light'

/** Discrete UI zoom factors offered in General settings. */
export const UI_SCALES = [0.9, 1.0, 1.1, 1.25, 1.5] as const
export type UiScale = (typeof UI_SCALES)[number]
const UI_SCALE_DEFAULT: UiScale = 1.0

export interface UiState {
  theme: Theme
  uiScale: UiScale
  showToolCalls: boolean
  findingsCollapsed: boolean
  evidenceCollapsed: boolean
  findingsWidth: number
  /** Recently opened cases shown as top-bar tabs. Intentionally not persisted — resets on app restart. */
  recentTabs: string[]
  /** Last-viewed chat session per case, keyed by slug. Intentionally not persisted — resets on app restart. */
  activeSessions: Record<string, number>
}

const KEYS = {
  theme: 'argus.ui.theme',
  uiScale: 'argus.ui.uiScale',
  showToolCalls: 'argus.ui.showToolCalls',
  findingsCollapsed: 'argus.ui.findingsCollapsed',
  evidenceCollapsed: 'argus.ui.evidenceCollapsed',
  findingsWidth: 'argus.ui.findingsWidth'
} as const

export const FINDINGS_MIN_WIDTH = 240
/** Center chat column never shrinks below this; the findings drag clamps against it. */
export const CHAT_MIN_WIDTH = 360
export const FINDINGS_MAX_WIDTH = 640
const FINDINGS_DEFAULT_WIDTH = 384

function readPersisted(): Omit<UiState, 'recentTabs' | 'activeSessions'> {
  const theme = localStorage.getItem(KEYS.theme)
  const width = Number(localStorage.getItem(KEYS.findingsWidth))
  const scale = Number(localStorage.getItem(KEYS.uiScale))
  return {
    theme: theme === 'light' ? 'light' : 'dark',
    uiScale: (UI_SCALES as readonly number[]).includes(scale)
      ? (scale as UiScale)
      : UI_SCALE_DEFAULT,
    showToolCalls: localStorage.getItem(KEYS.showToolCalls) !== 'false',
    findingsCollapsed: localStorage.getItem(KEYS.findingsCollapsed) === 'true',
    evidenceCollapsed: localStorage.getItem(KEYS.evidenceCollapsed) === 'true',
    findingsWidth:
      Number.isFinite(width) && width >= FINDINGS_MIN_WIDTH && width <= FINDINGS_MAX_WIDTH
        ? width
        : FINDINGS_DEFAULT_WIDTH
  }
}

export class UiStore {
  private state: UiState
  private listeners = new Set<() => void>()

  constructor() {
    this.state = { ...readPersisted(), recentTabs: [], activeSessions: {} }
    this.applyTheme()
    this.applyScale()
    void window.argus?.panels?.setTheme(this.state.theme)

    // Each BrowserWindow runs its own UiStore, reading the persisted theme once at load.
    // Without this, a theme change made in one window never reaches the others: open the
    // editor, switch theme in the main window, and the editor stays on the old palette
    // until it is reopened. Adopt-only — no persist, no re-broadcast (see `adoptTheme`).
    window.argus?.ui?.onThemeChanged?.((theme) => this.adoptTheme(theme))
  }

  /**
   * Apply a theme change that originated in another window.
   *
   * Deliberately not `setTheme`: the originating window already persisted it and already told
   * the panel host. Re-persisting here would race on shared localStorage, and re-broadcasting
   * would bounce the event back to the sender — main fans out to every window including the
   * one that sent it.
   */
  private adoptTheme(theme: Theme): void {
    if (theme === this.state.theme) return
    this.set({ theme })
    this.applyTheme()
  }

  get(): UiState {
    return this.state
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch }
    for (const cb of this.listeners) cb()
  }

  private applyTheme(): void {
    document.documentElement.setAttribute('data-theme', this.state.theme)
  }

  private applyScale(): void {
    window.argus?.ui?.setZoomFactor(this.state.uiScale)
  }

  /**
   * Push the persisted theme + zoom onto *this* document. The constructor already does it, but
   * that only helps a window whose import graph reaches this module — the editor window's does
   * not, and `theme.css` puts the dark tokens on bare `:root`, so a light-theme user got a black
   * editor window beside a cream main window. Called explicitly from `editor.tsx` rather than
   * relying on a bare side-effect import, so a bundler can never drop it as unused.
   */
  applyToDocument(): void {
    this.applyTheme()
    this.applyScale()
  }

  setUiScale(scale: UiScale): void {
    this.set({ uiScale: scale })
    localStorage.setItem(KEYS.uiScale, String(scale))
    this.applyScale()
  }

  setTheme(theme: Theme): void {
    this.set({ theme })
    localStorage.setItem(KEYS.theme, theme)
    this.applyTheme()
    void window.argus?.panels?.setTheme(theme)
  }

  toggleTheme(): void {
    this.setTheme(this.state.theme === 'dark' ? 'light' : 'dark')
  }

  setShowToolCalls(show: boolean): void {
    this.set({ showToolCalls: show })
    localStorage.setItem(KEYS.showToolCalls, String(show))
  }

  toggleToolCalls(): void {
    this.setShowToolCalls(!this.state.showToolCalls)
  }

  setFindingsCollapsed(collapsed: boolean): void {
    this.set({ findingsCollapsed: collapsed })
    localStorage.setItem(KEYS.findingsCollapsed, String(collapsed))
  }

  setEvidenceCollapsed(collapsed: boolean): void {
    this.set({ evidenceCollapsed: collapsed })
    localStorage.setItem(KEYS.evidenceCollapsed, String(collapsed))
  }

  setFindingsWidth(width: number): void {
    const clamped = Math.min(FINDINGS_MAX_WIDTH, Math.max(FINDINGS_MIN_WIDTH, Math.round(width)))
    this.set({ findingsWidth: clamped })
    localStorage.setItem(KEYS.findingsWidth, String(clamped))
  }

  openTab(slug: string): void {
    if (this.state.recentTabs.includes(slug)) return
    this.set({ recentTabs: [...this.state.recentTabs, slug] })
  }

  closeTab(slug: string): void {
    this.set({ recentTabs: this.state.recentTabs.filter((t) => t !== slug) })
  }

  setActiveSession(slug: string, id: number): void {
    this.set({ activeSessions: { ...this.state.activeSessions, [slug]: id } })
  }
}

export const uiStore = new UiStore()
