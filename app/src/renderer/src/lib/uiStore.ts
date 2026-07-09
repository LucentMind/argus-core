export type Theme = 'dark' | 'light'

export interface UiState {
  theme: Theme
  showToolCalls: boolean
  findingsCollapsed: boolean
  findingsWidth: number
  /** Recently opened cases shown as top-bar tabs. Intentionally not persisted — resets on app restart. */
  recentTabs: string[]
}

const KEYS = {
  theme: 'argus.ui.theme',
  showToolCalls: 'argus.ui.showToolCalls',
  findingsCollapsed: 'argus.ui.findingsCollapsed',
  findingsWidth: 'argus.ui.findingsWidth'
} as const

export const FINDINGS_MIN_WIDTH = 240
export const FINDINGS_MAX_WIDTH = 640
const FINDINGS_DEFAULT_WIDTH = 384

function readPersisted(): Omit<UiState, 'recentTabs'> {
  const theme = localStorage.getItem(KEYS.theme)
  const width = Number(localStorage.getItem(KEYS.findingsWidth))
  return {
    theme: theme === 'light' ? 'light' : 'dark',
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
    this.state = { ...readPersisted(), recentTabs: [] }
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
}

export const uiStore = new UiStore()
