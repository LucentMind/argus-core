import { useSyncExternalStore } from 'react'

/**
 * What the header needs from Settings but cannot get as a prop (spec
 * 2026-08-01-header-window-controls-design.md §5.2).
 *
 * `TopBar` is a SIBLING of the settings view, not an ancestor, and `App` knows only the deep link
 * it opened Settings with — usually `undefined`. The live answer lives in `SettingsView`'s own
 * state, next to two other pieces (`proposalTypes`, `libraryKind`) that `goTo()` clears with it
 * and an adjust-during-render deep-link sync. Lifting one of the three into `App` would split a
 * coherent unit across two files for a display concern.
 *
 * So this mirrors `caseBarStore`, which exists for exactly this shape: the view publishes, the bar
 * subscribes, `App` stays out of it.
 *
 * `null` means "Settings is not up". That is also the check `TopBar` uses to decide whether it
 * owns the ambient anchors, so there is one source of truth for it.
 */
export interface SettingsBarState {
  readonly label: string
  readonly blurb: string
}

class SettingsBarStore {
  private state: SettingsBarState | null = null
  private listeners = new Set<() => void>()

  get = (): SettingsBarState | null => this.state

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /**
   * Publish the active page's identity, or `null` on leaving Settings.
   *
   * No-ops when nothing changed. `SettingsView` calls this from an effect, and
   * `useSyncExternalStore` re-renders whenever `get()`'s identity changes — handing out a fresh
   * object for an unchanged page would be an infinite render loop, not just wasted work. Same
   * reasoning as `caseBarStore.publish`.
   */
  publish(next: SettingsBarState | null): void {
    const s = this.state
    if (s === next) return
    if (s && next && s.label === next.label && s.blurb === next.blurb) return
    this.state = next
    for (const cb of this.listeners) cb()
  }

  /** Tests only. */
  reset(): void {
    this.state = null
    this.listeners.clear()
  }
}

export const settingsBarStore = new SettingsBarStore()

export function useSettingsBar(): SettingsBarState | null {
  return useSyncExternalStore(settingsBarStore.subscribe, settingsBarStore.get)
}
