import { useEffect, useSyncExternalStore } from 'react'
import type { RoutinesPayload } from '../../../shared/routines'

/**
 * Renderer mirror of the main-process RoutinesService payload.
 *
 * Two surfaces need it now — the Settings page and the Home inbox — and `routines:changed` is
 * payload-free, so every consumer has to re-read rather than trust a pushed snapshot. Hand-
 * rolling that effect twice would mean two places to get the ordering wrong, and only one of
 * them would have a test.
 */
export interface RoutinesState {
  payload: RoutinesPayload | null
  /** A failed read. Separate from `payload` so a failed REFRESH keeps the last good list. */
  error: string | null
}

const EMPTY: RoutinesState = { payload: null, error: null }

export class RoutinesStore {
  private state: RoutinesState = EMPTY
  private listeners = new Set<() => void>()
  private started = false

  /** Idempotent: the first call reads the payload and subscribes to routines:changed. */
  start(): void {
    if (this.started) return
    this.started = true
    this.reload()
    // Runs start, finish and get reconciled in main; another window can mark one reviewed; a
    // hand-edit of config/routines.json changes the definitions. All of it arrives here.
    window.argus.routines.onChanged(() => this.reload())
  }

  /** Test-only escape hatch: forces the next start() to refetch against a fresh mock. */
  reset(): void {
    this.started = false
    this.state = EMPTY
  }

  private reload(): void {
    void window.argus.routines
      .list()
      .then((payload) => this.set({ payload, error: null }))
      .catch((err: unknown) =>
        // Last good payload survives: a failed refresh must not blank a list mid-read.
        this.set({
          payload: this.state.payload,
          error: err instanceof Error ? err.message : String(err)
        })
      )
  }

  private set(next: RoutinesState): void {
    this.state = next
    for (const cb of this.listeners) cb()
  }

  /** Stable reference between changes — useSyncExternalStore requires it. */
  get(): RoutinesState {
    return this.state
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}

export const routinesStore = new RoutinesStore()

export function useRoutinesPayload(): RoutinesState {
  useEffect(() => {
    routinesStore.start()
  }, [])
  return useSyncExternalStore(
    (cb) => routinesStore.subscribe(cb),
    () => routinesStore.get()
  )
}
