import type { ModeId } from '../../../shared/modes'

/**
 * Bar → workspace. `ModeSwitcher` lives in the bar now, but everything that has to happen
 * after a switch — select the new chat, refetch the session list, offer the PR picker —
 * lives in CaseWorkspace behind race guards that are not worth moving for a layout change.
 *
 * This is an event channel only. There used to be a state channel alongside it
 * (`publish`/`subscribe`/`useCaseBar`, carrying `busyMode`/`statusText`) whose sole purpose
 * was to keep the bar's Review button spinning through the PR search that outlives
 * `cases.setMode`. That search now reports in the Pull request rail instead — the mode
 * switch is over by the time it starts, so a spinner on the switch control was claiming
 * otherwise — which left the state channel with no producer at all.
 */
export type CaseBarEvent =
  | { kind: 'mode-switched'; slug: string; mode: ModeId; sessionId: number }
  | { kind: 'mode-error'; slug: string; message: string }

class CaseBarStore {
  private eventListeners = new Set<(event: CaseBarEvent) => void>()

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
    this.eventListeners.clear()
  }
}

export const caseBarStore = new CaseBarStore()
