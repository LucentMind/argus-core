import { useEffect, useSyncExternalStore } from 'react'
import type { AgentAccessPayload } from '../../../shared/agentAccess'

/**
 * Renderer mirror of the main-process AgentAccessStore — same
 * external-store idiom as settingsStore/connectorsStore (useSyncExternalStore),
 * same optimistic patch + banner-on-failure.
 */
class AccessStore {
  private payload: AgentAccessPayload | null = null
  private listeners = new Set<() => void>()
  private started = false

  /** Idempotent: first call fetches the payload and subscribes to access:changed. */
  start(): void {
    if (this.started) return
    this.started = true
    void window.argus.access
      .get()
      .then((p: AgentAccessPayload) => this.set(p))
      .catch((err) => console.error('access load failed', err))
    window.argus.access.onChanged((p: AgentAccessPayload) => this.set(p))
  }

  /** Test-only escape hatch: forces the next start() to refetch against a fresh mock. */
  reset(): void {
    this.started = false
    this.payload = null
  }

  private set(p: AgentAccessPayload): void {
    this.payload = p
    for (const cb of this.listeners) cb()
  }

  get(): AgentAccessPayload | null {
    return this.payload
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async patch(p: unknown): Promise<void> {
    try {
      this.set(await window.argus.access.patch(p))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (this.payload) this.set({ ...this.payload, loadError: `access save failed: ${message}` })
    }
  }
}

export const accessStore = new AccessStore()

export function useAccessPayload(): AgentAccessPayload | null {
  useEffect(() => {
    accessStore.start()
  }, [])
  return useSyncExternalStore(
    (cb) => accessStore.subscribe(cb),
    () => accessStore.get()
  )
}
