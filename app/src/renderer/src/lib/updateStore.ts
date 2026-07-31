import type { CoreUpdatePayload } from '../../../shared/updates'

/**
 * App-update state, fed by one `update:changed` broadcast from main. `start()` is idempotent so
 * every consumer (Settings block, banner) can call it on mount without racing.
 */
class UpdateStore {
  private payload: CoreUpdatePayload = { currentVersion: '', status: { phase: 'idle' } }
  private dismissedVersion: string | null = null
  private readonly listeners = new Set<() => void>()
  private started = false

  get(): CoreUpdatePayload {
    return this.payload
  }

  /** The banner hides once dismissed, until a different version shows up. */
  isDismissed(version: string): boolean {
    return this.dismissedVersion === version
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  start(): void {
    if (this.started) return
    this.started = true
    window.argus.update.onChanged((p) => this.set(p))
    void window.argus.update.status().then((p) => this.set(p))
  }

  async check(): Promise<void> {
    this.set(await window.argus.update.check())
  }

  async download(): Promise<void> {
    this.set(await window.argus.update.download())
  }

  restart(): void {
    void window.argus.update.restart()
  }

  dismiss(): void {
    const s = this.payload.status
    this.dismissedVersion = s.phase === 'available' || s.phase === 'ready' ? s.version : null
    this.emit()
  }

  /** Test-only: the module-level singleton outlives each test's stubbed `window.argus`.
   *  Named to match the existing `reposStore.clearForTests()` precedent. */
  clearForTests(): void {
    this.payload = { currentVersion: '', status: { phase: 'idle' } }
    this.dismissedVersion = null
    this.started = false
    this.listeners.clear()
  }

  private set(p: CoreUpdatePayload): void {
    this.payload = p
    this.emit()
  }

  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}

export const updateStore = new UpdateStore()
