import { describe, it, expect, vi } from 'vitest'
import { createElectronUpdaterBackend, type AutoUpdaterLike } from '../electronUpdaterBackend'

/** Minimal EventEmitter-shaped stand-in for electron-updater's autoUpdater. */
function fakeAu(): AutoUpdaterLike & {
  emit: (e: string, arg?: unknown) => void
  listenerCount: (event: string) => number
  channel: string
} {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  return {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    allowDowngrade: true,
    // Not part of AutoUpdaterLike, so the adapter cannot assign it without a type error — but
    // an interface can be widened later, and electron-updater's `channel` setter forces
    // allowDowngrade = true as a side effect (AppUpdater.js:33-45), which would silently undo
    // the scoping the tests below pin down. Fail loudly if anyone ever reaches for it.
    get channel(): string {
      return ''
    },
    set channel(_v: string) {
      throw new Error('the adapter must never assign autoUpdater.channel')
    },
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(cb)
      return this
    },
    off(event, cb) {
      handlers.get(event)?.delete(cb)
      return this
    },
    emit(event, arg) {
      for (const cb of [...(handlers.get(event) ?? [])]) cb(arg)
    },
    listenerCount(event) {
      return handlers.get(event)?.size ?? 0
    }
  }
}

describe('createElectronUpdaterBackend', () => {
  it('disables auto-download — this is what makes the flow notify-first', () => {
    const au = fakeAu()
    createElectronUpdaterBackend(au)
    expect(au.autoDownload).toBe(false)
    expect(au.autoInstallOnAppQuit).toBe(true)
  })

  // Construction no longer decides the release track — setChannel does, and the service calls
  // it from its own constructor before any check can run.
  it('maps beta to allowPrerelease, and never downgrades while on the prerelease track', () => {
    const au = fakeAu()
    createElectronUpdaterBackend(au).setChannel('beta', '2.1.2')
    expect(au.allowPrerelease).toBe(true)
    expect(au.allowDowngrade).toBe(false)
  })

  it('allows a downgrade only when a prerelease install asks for stable', () => {
    const au = fakeAu()
    createElectronUpdaterBackend(au).setChannel('stable', '2.2.0-beta.1')
    expect(au.allowPrerelease).toBe(false)
    // Without this, leaving the beta track would offer nothing until the next stable release
    // exceeded 2.2.0-beta.1 — a broken beta would be a reinstall-by-hand.
    expect(au.allowDowngrade).toBe(true)
  })

  it('never drags an ordinary stable install backwards', () => {
    const au = fakeAu()
    createElectronUpdaterBackend(au).setChannel('stable', '2.1.2')
    expect(au.allowPrerelease).toBe(false)
    // A yanked or deleted release must not become a downgrade offer for someone who never
    // opted into prereleases at all.
    expect(au.allowDowngrade).toBe(false)
  })

  it('installs a permanent error sink at construction time, before any check() runs', () => {
    const au = fakeAu()
    createElectronUpdaterBackend(au)
    // electron-updater emits 'error' out-of-band (Squirrel ctor handler, installer spawn
    // failures) outside any check() window. EventEmitter throws on an unhandled 'error' with
    // zero listeners, so this sink must exist from construction, not just during a check.
    expect(au.listenerCount('error')).toBe(1)
  })

  it('resolves a found update from the update-available event', async () => {
    const au = fakeAu()
    const b = createElectronUpdaterBackend(au)
    const p = b.check()
    au.emit('update-available', { version: '1.1.0', releaseNotes: 'notes' })
    await expect(p).resolves.toEqual({ version: '1.1.0', notes: 'notes' })
  })

  it('resolves null from update-not-available', async () => {
    const au = fakeAu()
    const b = createElectronUpdaterBackend(au)
    const p = b.check()
    au.emit('update-not-available', { version: '1.0.8' })
    await expect(p).resolves.toBeNull()
  })

  it('rejects on the error event', async () => {
    const au = fakeAu()
    const b = createElectronUpdaterBackend(au)
    const p = b.check()
    au.emit('error', new Error('feed 404'))
    await expect(p).rejects.toThrow('feed 404')
  })

  it('drops non-string releaseNotes rather than rendering an object', async () => {
    const au = fakeAu()
    const b = createElectronUpdaterBackend(au)
    const p = b.check()
    au.emit('update-available', { version: '1.1.0', releaseNotes: [{ note: 'x' }] })
    await expect(p).resolves.toEqual({ version: '1.1.0', notes: undefined })
  })

  it('unsubscribes its one-shot listeners so a second check is not double-settled', async () => {
    const au = fakeAu()
    const b = createElectronUpdaterBackend(au)
    const first = b.check()
    au.emit('update-not-available')
    await first
    // Assert listener counts are back to 0 after the first check settles — cleanup occurred
    expect(au.listenerCount('update-available')).toBe(0)
    expect(au.listenerCount('update-not-available')).toBe(0)
    // The permanent error sink installed at construction survives settle(): it's back to 1,
    // not 0 — settle() removes only check()'s own transient 'error' listener.
    expect(au.listenerCount('error')).toBe(1)

    const second = b.check()
    au.emit('update-available', { version: '2.0.0' })
    await expect(second).resolves.toEqual({ version: '2.0.0', notes: undefined })
  })

  it('rejects when checkForUpdates() itself fails', async () => {
    const au = fakeAu()
    au.checkForUpdates = vi.fn(async () => {
      throw new Error('network down')
    })
    const b = createElectronUpdaterBackend(au)
    const p = b.check()
    // No event is emitted; rejection comes directly from checkForUpdates
    await expect(p).rejects.toThrow('network down')
    // Assert listener counts are back to 0 after rejection — cleanup occurred on this path too
    expect(au.listenerCount('update-available')).toBe(0)
    expect(au.listenerCount('update-not-available')).toBe(0)
    // Back to 1 (the permanent sink), not 0 — see the construction-time test above.
    expect(au.listenerCount('error')).toBe(1)
  })

  it('forwards rounded download progress', () => {
    const au = fakeAu()
    const b = createElectronUpdaterBackend(au)
    const seen: number[] = []
    b.onProgress((p) => void seen.push(p))
    au.emit('download-progress', { percent: 41.6 })
    expect(seen).toEqual([42])
  })
})
