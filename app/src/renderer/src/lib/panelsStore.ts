import type { PanelInfo, PanelKey, PanelDecl } from '../../../shared/panels'
import { panelKeyStr } from '../../../shared/panels'

/** The always-present first tab. Panel tabs use panelKeyStr(info) as their id. */
export const CHAT_TAB = 'chat'

export interface PanelsState {
  /** The case these panels belong to; null before the first setCase. */
  caseSlug: string | null
  panels: PanelInfo[]
  /** CHAT_TAB or a panelKeyStr. */
  activeTab: string
  /** A modal/dialog occludes the center region, or the case is not the front view. */
  occluded: boolean
  /** Available webPanels (launcher + "Open in"). Case-independent. */
  decls: PanelDecl[]
}

export class PanelsStore {
  private state: PanelsState = {
    caseSlug: null,
    panels: [],
    activeTab: CHAT_TAB,
    occluded: false,
    decls: []
  }
  private listeners = new Set<() => void>()
  // `occluded` (whether the docked native view must hide) has two independent sources: a
  // modal/dialog/off-case front view, and the launcher dropdown being open. Track them
  // separately and OR them, so releasing one doesn't un-hide the view while the other is up.
  private modalOccluded = false
  private launcherOpen = false

  get(): PanelsState {
    return this.state
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private set(patch: Partial<PanelsState>): void {
    this.state = { ...this.state, ...patch }
    for (const cb of this.listeners) cb()
  }

  /** Point the store at a case; a slug change drops the previous case's panels + active tab. */
  setCase(slug: string): void {
    if (this.state.caseSlug === slug) return
    this.set({ caseSlug: slug, panels: [], activeTab: CHAT_TAB })
  }

  /** Sync the open-panel list (mount hydrate + panels:changed); collapse to Chat if the active panel vanished. */
  setPanels(panels: PanelInfo[]): void {
    const active =
      this.state.activeTab === CHAT_TAB ||
      panels.some((p) => panelKeyStr(p) === this.state.activeTab)
        ? this.state.activeTab
        : CHAT_TAB
    this.set({ panels, activeTab: active })
  }

  setActiveTab(tab: string): void {
    this.set({ activeTab: tab })
  }

  /** Modal/dialog/off-case occlusion source (from App). ORed with the launcher-open source. */
  setOccluded(occluded: boolean): void {
    this.modalOccluded = occluded
    this.recomputeOcclusion()
  }

  /** The launcher dropdown is DOM a docked native panel view would paint over; treat it as an
   *  occluder so the view hides while the menu is open (mirrors modal occlusion). */
  setLauncherOpen(open: boolean): void {
    this.launcherOpen = open
    this.recomputeOcclusion()
  }

  private recomputeOcclusion(): void {
    const occluded = this.modalOccluded || this.launcherOpen
    if (occluded !== this.state.occluded) this.set({ occluded })
  }

  setDecls(decls: PanelDecl[]): void {
    this.set({ decls })
  }

  /** The PanelKey of the active panel tab, or null when Chat is active. */
  activeKey(): PanelKey | null {
    if (this.state.activeTab === CHAT_TAB) return null
    const p = this.state.panels.find((x) => panelKeyStr(x) === this.state.activeTab)
    return p ? { caseSlug: p.caseSlug, packId: p.packId, windowId: p.windowId } : null
  }
}

export const panelsStore = new PanelsStore()

/**
 * Wire the singleton to Core for a case: load decls + the open-panel list, and
 * re-list on the panels:changed broadcast. Returns an unsubscribe for effect cleanup.
 */
export function wirePanelsStore(slug: string): () => void {
  panelsStore.setCase(slug)
  if (!window.argus?.panels) return () => {}

  // guard against a slow decls()/list() from a previous case resolving after a
  // newer setCase, writing stale data over the current case's state
  let stale = false
  void window.argus.panels.decls().then(
    (d) => {
      if (!stale) panelsStore.setDecls(d)
    },
    () => {
      if (!stale) panelsStore.setDecls([])
    }
  )
  const resync = (): void => {
    void window.argus.panels.list(slug).then(
      (list) => {
        if (!stale) panelsStore.setPanels(list)
      },
      () => {
        if (!stale) panelsStore.setPanels([])
      }
    )
  }
  resync()
  const offChanged = window.argus.panels.onChanged(resync)
  return () => {
    stale = true
    offChanged()
  }
}
