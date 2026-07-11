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
  findingsWidth: 'argus.ui.findingsWidth'
} as const

export const FINDINGS_MIN_WIDTH = 240
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

  setUiScale(scale: UiScale): void {
    this.set({ uiScale: scale })
    localStorage.setItem(KEYS.uiScale, String(scale))
    this.applyScale()
  }

  setTheme(theme: Theme): void {
    this.set({ theme })
    localStorage.setItem(KEYS.theme, theme)
    this.applyTheme()
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
