import { useSyncExternalStore } from 'react'
import type { ModeId } from '../../../shared/modes'

/** What the merged bar needs from the workspace but cannot get as a prop, because App does
 *  not know it: review's PR search outlives `cases.setMode`, and only CaseWorkspace runs it. */
export interface CaseBarState {
  /** Whose state this is. A stale publish from the case you just left must not be read as
   *  the current case's busy state. */
  slug: string | null
  busyMode: ModeId | null
  statusText: string | null
}

/** Bar → workspace. `ModeSwitcher` lives in the bar now, but everything that has to happen
 *  after a switch — select the new chat, refetch the session list, offer the PR picker —
 *  lives in CaseWorkspace behind race guards that are not worth moving for a layout change. */
export type CaseBarEvent =
  | { kind: 'mode-switched'; slug: string; mode: ModeId; sessionId: number }
  | { kind: 'mode-error'; slug: string; message: string }

const EMPTY: CaseBarState = { slug: null, busyMode: null, statusText: null }

class CaseBarStore {
  private state: CaseBarState = EMPTY
  private listeners = new Set<() => void>()
  private eventListeners = new Set<(event: CaseBarEvent) => void>()

  get = (): CaseBarState => this.state

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /**
   * Publish the workspace's current busy state.
   *
   * No-ops when nothing changed. CaseWorkspace calls this from an effect that runs on every
   * render, and `useSyncExternalStore` re-renders whenever `get()`'s identity changes — a
   * fresh object every time would be an infinite render loop, not just wasted work.
   */
  publish(next: CaseBarState): void {
    const s = this.state
    if (s.slug === next.slug && s.busyMode === next.busyMode && s.statusText === next.statusText) {
      return
    }
    this.state = next
    for (const cb of this.listeners) cb()
  }

  emit(event: CaseBarEvent): void {
    for (const cb of this.eventListeners) cb(event)
  }

  /** Subscribe to events for one case only. The slug check lives here rather than in each
   *  consumer so there is exactly one place it can be forgotten. */
  onEventFor(slug: string, cb: (event: CaseBarEvent) => void): () => void {
    const filtered = (event: CaseBarEvent): void => {
      if (event.slug === slug) cb(event)
    }
    this.eventListeners.add(filtered)
    return () => {
      this.eventListeners.delete(filtered)
    }
  }

  /** Tests only. */
  reset(): void {
    this.state = EMPTY
    this.listeners.clear()
    this.eventListeners.clear()
  }
}

export const caseBarStore = new CaseBarStore()

export function useCaseBar(): CaseBarState {
  return useSyncExternalStore(caseBarStore.subscribe, caseBarStore.get)
}
