import type { UpdateStatus, CoreUpdatePayload } from '../../../shared/updates'

/** Safely extract a message string from any rejection value. */
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The seam over electron-updater. Deliberately four methods: everything the service needs and
 * nothing electron-updater-shaped, so the state machine can be tested without Electron.
 *
 * There is no `onError`. Failures surface as rejections from `check`/`download`, which the
 * service already handles. An additional out-of-band error channel would double-report every
 * failure — including turning a silent boot-check failure into a visible one.
 */
export interface UpdaterBackend {
  check(): Promise<{ version: string; notes?: string } | null>
  download(): Promise<void>
  quitAndInstall(): void
  onProgress(cb: (percent: number) => void): void
}

/** Used when updates are structurally impossible (unpackaged build). */
export const noopBackend: UpdaterBackend = {
  check: async () => null,
  download: async () => {},
  quitAndInstall: () => {},
  onProgress: () => {}
}

export interface CoreUpdaterDeps {
  backend: UpdaterBackend
  /** `app.getVersion()`. */
  currentVersion: string
  /** `app.isPackaged`. False ⇒ the updater must never run. */
  supported: boolean
  now?: () => number
}

export class CoreUpdaterService {
  private status: UpdateStatus
  private readonly listeners = new Set<(p: CoreUpdatePayload) => void>()
  private readonly now: () => number

  constructor(private readonly deps: CoreUpdaterDeps) {
    this.now = deps.now ?? Date.now
    this.status = deps.supported
      ? { phase: 'idle' }
      : { phase: 'unsupported', reason: 'Updates are only available in a packaged build' }
    // Guarded: a progress event arriving after the download resolves must not knock the
    // status back off `ready`.
    deps.backend.onProgress((percent) => {
      if (this.status.phase === 'downloading') this.set({ phase: 'downloading', percent })
    })
  }

  payload(): CoreUpdatePayload {
    return { currentVersion: this.deps.currentVersion, status: this.status }
  }

  subscribe(cb: (p: CoreUpdatePayload) => void): () => void {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  /**
   * `manual: false` is the boot check. Its failures go back to idle and are only logged —
   * someone working offline must not get a failure banner on every launch. A check the user
   * explicitly asked for reports its failure.
   */
  async check(opts: { manual: boolean }): Promise<CoreUpdatePayload> {
    const p = this.status.phase
    if (p === 'unsupported' || p === 'checking' || p === 'downloading' || p === 'ready') return this.payload()
    this.set({ phase: 'checking' })
    try {
      const found = await this.deps.backend.check()
      this.set(
        found
          ? { phase: 'available', version: found.version, notes: found.notes }
          : { phase: 'idle' }
      )
    } catch (err) {
      const message = messageOf(err)
      if (opts.manual) this.set({ phase: 'error', message, at: this.now() })
      else {
        console.warn(`[update] boot check failed: ${message}`)
        this.set({ phase: 'idle' })
      }
    }
    return this.payload()
  }

  async download(): Promise<CoreUpdatePayload> {
    if (this.status.phase !== 'available') return this.payload()
    const { version } = this.status
    this.set({ phase: 'downloading', percent: 0 })
    try {
      await this.deps.backend.download()
      this.set({ phase: 'ready', version })
    } catch (err) {
      this.set({ phase: 'error', message: messageOf(err), at: this.now() })
    }
    return this.payload()
  }

  restart(): void {
    if (this.status.phase === 'ready') this.deps.backend.quitAndInstall()
  }

  private set(status: UpdateStatus): void {
    this.status = status
    const p = this.payload()
    for (const cb of this.listeners) cb(p)
  }
}
