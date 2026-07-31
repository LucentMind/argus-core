import type { UpdaterBackend } from './coreUpdater'

/**
 * The slice of electron-updater's `autoUpdater` this adapter drives, declared structurally so
 * the unit test can supply a fake. Importing electron-updater in a test would reach for
 * Electron's `app` at module load.
 */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  on(event: string, cb: (payload: unknown) => void): unknown
  off(event: string, cb: (payload: unknown) => void): unknown
}

/** electron-updater's `update-available` payload, narrowed to the two fields read here. */
interface UpdateInfoLike {
  version: string
  releaseNotes?: unknown
}

export function createElectronUpdaterBackend(au: AutoUpdaterLike): UpdaterBackend {
  // `autoDownload = false` IS the notify-first decision (spec §3). Without it electron-updater
  // fetches the moment it finds an update. `autoInstallOnAppQuit` keeps an update the user
  // downloaded but never restarted for from being wasted.
  au.autoDownload = false
  au.autoInstallOnAppQuit = true
  au.allowPrerelease = false

  const progressCbs = new Set<(percent: number) => void>()
  au.on('download-progress', (payload) => {
    const pct = Math.round((payload as { percent?: number } | undefined)?.percent ?? 0)
    for (const cb of progressCbs) cb(pct)
  })

  // EventEmitter throws when 'error' is emitted with no listener, and electron-updater emits it
  // out-of-band (Squirrel on macOS from a constructor-registered handler, installer spawn on
  // Windows) — outside any check() window, where check()'s transient listener is gone. This sink
  // only logs: check() still reports in-check failures through its own listener.
  au.on('error', (payload) => {
    console.warn('[update] autoUpdater error:', payload)
  })

  return {
    // Settled from the EVENTS rather than from `checkForUpdates()`'s return value: that promise
    // resolves in both the update and no-update cases and its shape has shifted across
    // electron-updater majors, whereas these three events have been stable.
    check: () =>
      new Promise((resolve, reject) => {
        const settle = (fn: () => void): void => {
          au.off('update-available', onAvailable)
          au.off('update-not-available', onNone)
          au.off('error', onError)
          fn()
        }
        const onAvailable = (payload: unknown): void => {
          const info = payload as UpdateInfoLike
          settle(() =>
            resolve({
              version: info.version,
              // releaseNotes is a string, an array of release objects, or null depending on
              // provider and config. Anything but a string is dropped rather than stringified.
              notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
            })
          )
        }
        const onNone = (): void => settle(() => resolve(null))
        const onError = (payload: unknown): void => settle(() => reject(payload as Error))
        au.on('update-available', onAvailable)
        au.on('update-not-available', onNone)
        au.on('error', onError)
        au.checkForUpdates().catch((err) => settle(() => reject(err as Error)))
      }),
    download: async () => {
      await au.downloadUpdate()
    },
    quitAndInstall: () => au.quitAndInstall(),
    onProgress: (cb) => void progressCbs.add(cb)
  }
}
