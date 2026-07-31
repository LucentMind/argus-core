import type { CoreUpdatePayload } from '../../../shared/updates'

/**
 * App-update state, fed by one `update:changed` broadcast from main. `start()` is idempotent so
 * every consumer (Settings block, banner) can call it on mount without racing.
 */
class UpdateStore {
  private payload: CoreUpdatePayload = { currentVersion: '', status: { phase: 'idle' } }
  private dismissedKey: string | null = null
  private readonly listeners = new Set<() => void>()
  private started = false

  get(): CoreUpdatePayload {
    return this.payload
  }

  /**
   * The banner hides once dismissed, until a different phase or version shows up.
   * Deliberately survives an available → idle → available round trip for the SAME version:
   * the user already declined that version, and idle carries no version to key on anyway. It
   * only recurs if the release is un-published and re-published (or a new version ships).
   */
  isDismissed(phase: 'available' | 'ready', version: string): boolean {
    return this.dismissedKey === `${phase}:${version}`
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

  async restart(): Promise<void> {
    this.set(await window.argus.update.restart())
  }

  dismiss(): void {
    const s = this.payload.status
    this.dismissedKey =
      s.phase === 'available' || s.phase === 'ready' ? `${s.phase}:${s.version}` : null
    // UpdateBanner's useSyncExternalStore snapshot is `this.payload`; isDismissed() is derived
    // state that lives outside it. React skips re-rendering when getSnapshot returns the same
    // reference, so a dismissal that only touches `dismissedKey` would never reach the banner —
    // give the snapshot a new identity so the subscriber actually re-renders.
    this.payload = { ...this.payload }
    this.emit()
  }

  /** Test-only: the module-level singleton outlives each test's stubbed `window.argus`.
   *  Named to match the existing `reposStore.clearForTests()` precedent. */
  clearForTests(): void {
    this.payload = { currentVersion: '', status: { phase: 'idle' } }
    this.dismissedKey = null
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
