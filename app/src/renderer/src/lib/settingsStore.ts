import { useEffect, useSyncExternalStore } from 'react'
import type { AppSettings, DeepPatch, SettingsPayload } from '../../../shared/settings'

/**
 * Renderer mirror of the main-process SettingsService. App-global keys only —
 * renderer-local values (theme, showToolCalls, pane sizes) live in uiStore and
 * are written there directly by the settings pages (split-patch by membership).
 */
export class SettingsStore {
  private payload: SettingsPayload | null = null
  private listeners = new Set<() => void>()
  private started = false

  /** Idempotent: first call fetches the payload and subscribes to settings:changed. */
  start(): void {
    if (this.started) return
    this.started = true
    void window.argus.settings
      .get()
      .then((p: SettingsPayload) => this.set(p))
      .catch((err) => console.error('settings load failed', err))
    window.argus.settings.onChanged((p: SettingsPayload) => this.set(p))
  }

  /** Test-only escape hatch: forces the next start() to refetch against a fresh mock. */
  reset(): void {
    this.started = false
    this.payload = null
  }

  private set(p: SettingsPayload): void {
    this.payload = p
    for (const cb of this.listeners) cb()
  }

  get(): SettingsPayload | null {
    return this.payload
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async patch(p: DeepPatch<AppSettings>): Promise<void> {
    try {
      this.set(await window.argus.settings.patch(p))
    } catch (err) {
      console.error('settings patch failed', err)
      const message = err instanceof Error ? err.message : String(err)
      if (this.payload) this.set({ ...this.payload, loadError: 'settings save failed: ' + message })
    }
  }
}

export const settingsStore = new SettingsStore()

export function useSettingsPayload(): SettingsPayload | null {
  useEffect(() => {
    settingsStore.start()
  }, [])
  return useSyncExternalStore(
    (cb) => settingsStore.subscribe(cb),
    () => settingsStore.get()
  )
}
