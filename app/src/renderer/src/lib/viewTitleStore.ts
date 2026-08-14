import { useSyncExternalStore } from 'react'

/**
 * The title of whichever full-page view is up, published for the header to render (spec
 * 2026-08-01-header-window-controls-design.md §5.2).
 *
 * `TopBar` is a SIBLING of those views, not an ancestor, and `App` knows only the deep link it
 * opened one with — usually `undefined`. Settings' live answer, for instance, lives in
 * `SettingsView`'s own state, next to two other pieces (`proposalTypes`, `libraryKind`) that
 * `goTo()` clears with it and an adjust-during-render deep-link sync. Lifting one of the three
 * into `App` would split a coherent unit across two files for a display concern.
 *
 * So this mirrors `caseBarStore`, which exists for exactly this shape: the view publishes, the bar
 * subscribes, `App` stays out of it.
 *
 * Settings was the first publisher; Proposals and Related history joined it (user-directed,
 * 2026-08-08) when their own title rows were deleted — a second bar under the header, carrying
 * one word and a close button, was pure height on views that already have a header.
 *
 * `null` means "no such view is up". That is also the check `TopBar` uses to decide whether it
 * owns the ambient anchors, so there is one source of truth for it.
 */
export interface ViewTitleState {
  readonly label: string
  /** Tooltip on the title. Settings' page blurb; the other views have none. */
  readonly blurb?: string
  /** A live count or similar, rendered muted after the label (e.g. `· 5 pending`). */
  readonly detail?: string
}

class ViewTitleStore {
  private state: ViewTitleState | null = null
  private listeners = new Set<() => void>()

  get = (): ViewTitleState | null => this.state

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /**
   * Publish the active view's identity, or `null` on leaving it.
   *
   * No-ops when nothing changed. Publishers call this from an effect, and `useSyncExternalStore`
   * re-renders whenever `get()`'s identity changes — handing out a fresh object for an unchanged
   * title would be an infinite render loop, not just wasted work.
   */
  publish(next: ViewTitleState | null): void {
    const s = this.state
    if (s === next) return
    if (s && next && s.label === next.label && s.blurb === next.blurb && s.detail === next.detail) {
      return
    }
    this.state = next
    for (const cb of this.listeners) cb()
  }

  /** Tests only. */
  reset(): void {
    this.state = null
    this.listeners.clear()
  }
}

export const viewTitleStore = new ViewTitleStore()

export function useViewTitle(): ViewTitleState | null {
  return useSyncExternalStore(viewTitleStore.subscribe, viewTitleStore.get)
}
