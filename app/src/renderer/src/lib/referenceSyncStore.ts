import { useEffect, useSyncExternalStore } from 'react'
import type { RefSyncPayload } from '../../../shared/referenceSync'

/**
 * Renderer mirror of the main-process ReferenceSyncStore/RefSyncService —
 * same external-store idiom as accessStore (useSyncExternalStore).
 */
class ReferenceSyncStoreMirror {
  private payload: RefSyncPayload | null = null
  private listeners = new Set<() => void>()
  private started = false

  /** Idempotent: first call fetches the payload and subscribes to refsync:changed. */
  start(): void {
    if (this.started) return
    this.started = true
    void window.argus.refsync
      .get()
      .then((p: RefSyncPayload) => this.set(p))
      .catch((err) => console.error('refsync load failed', err))
    window.argus.refsync.onChanged((p: RefSyncPayload) => this.set(p))
  }

  /** Test-only escape hatch: forces the next start() to refetch against a fresh mock. */
  reset(): void {
    this.started = false
    this.payload = null
  }

  set(p: RefSyncPayload): void {
    this.payload = p
    for (const cb of this.listeners) cb()
  }

  get(): RefSyncPayload | null {
    return this.payload
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}

export const referenceSyncStore = new ReferenceSyncStoreMirror()

export function useRefSyncPayload(): RefSyncPayload | null {
  useEffect(() => {
    referenceSyncStore.start()
  }, [])
  return useSyncExternalStore(
    (cb) => referenceSyncStore.subscribe(cb),
    () => referenceSyncStore.get()
  )
}
