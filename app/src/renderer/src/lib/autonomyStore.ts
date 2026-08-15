import { useEffect, useSyncExternalStore } from 'react'
import type { AutonomyPayload } from '../../../shared/autonomy'

/**
 * Renderer mirror of the autonomy payload (proposalsStore pattern). Primed from
 * autonomy.status() on first use, then refetched on every autonomy:changed broadcast —
 * the broadcast is payload-free by convention, so listeners re-read.
 */
export class AutonomyStore {
  private payload: AutonomyPayload | null = null
  private listeners = new Set<() => void>()
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    const fetch = (): void => {
      void window.argus.autonomy
        .status()
        .then((p) => this.set(p))
        .catch((e) => console.warn('autonomyStore: status() failed', e))
    }
    fetch()
    window.argus.autonomy.onChanged(fetch)
  }

  /** Test-only escape hatch: forces the next start() to refetch against a fresh mock. */
  reset(): void {
    this.started = false
    this.payload = null
  }

  /** Re-fetches status() when already started. A decision write (accept/reject/reviewed/
   *  confirmed/dismissed) elsewhere in the app now broadcasts `autonomy:changed`, so this is
   *  mostly redundant with that — but it also covers the case where the page mounts after an
   *  outcome was written in the same tick the broadcast fired, before this store's listener was
   *  attached, so opening the page never shows boot-stale data. */
  refresh(): void {
    if (!this.started) return
    void window.argus.autonomy
      .status()
      .then((p) => this.set(p))
      .catch((e) => console.warn('autonomyStore: refresh() failed', e))
  }

  private set(p: AutonomyPayload): void {
    this.payload = p
    for (const cb of this.listeners) cb()
  }

  get(): AutonomyPayload | null {
    return this.payload
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}

export const autonomyStore = new AutonomyStore()

export function useAutonomy(): AutonomyPayload | null {
  useEffect(() => {
    autonomyStore.start()
  }, [])
  return useSyncExternalStore(
    (cb) => autonomyStore.subscribe(cb),
    () => autonomyStore.get()
  )
}
