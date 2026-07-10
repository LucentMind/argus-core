import { useEffect, useSyncExternalStore } from 'react'
import type { ConnectorsPayload } from '../../../shared/connectors'

/**
 * Renderer mirror of the main-process ConnectorsService — same
 * external-store idiom as settingsStore (useSyncExternalStore), same
 * optimistic patch + banner-on-failure.
 */
class ConnectorsStore {
  private payload: ConnectorsPayload | null = null
  private listeners = new Set<() => void>()
  private started = false

  /** Idempotent: first call fetches the payload and subscribes to connectors:changed. */
  start(): void {
    if (this.started) return
    this.started = true
    void window.argus.connectors.get().then((p: ConnectorsPayload) => this.set(p))
    window.argus.connectors.onChanged((p: ConnectorsPayload) => this.set(p))
  }

  /** Test-only escape hatch: forces the next start() to refetch against a fresh mock. */
  reset(): void {
    this.started = false
    this.payload = null
  }

  private set(p: ConnectorsPayload): void {
    this.payload = p
    for (const cb of this.listeners) cb()
  }

  get(): ConnectorsPayload | null {
    return this.payload
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async patch(p: unknown): Promise<void> {
    try {
      this.set(await window.argus.connectors.patch(p))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (this.payload)
        this.set({ ...this.payload, loadError: `connector save failed: ${message}` })
    }
  }
}

export const connectorsStore = new ConnectorsStore()

export function useConnectorsPayload(): ConnectorsPayload | null {
  useEffect(() => {
    connectorsStore.start()
  }, [])
  return useSyncExternalStore(
    (cb) => connectorsStore.subscribe(cb),
    () => connectorsStore.get()
  )
}
