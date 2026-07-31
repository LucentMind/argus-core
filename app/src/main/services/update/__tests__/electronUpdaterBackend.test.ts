import { describe, it, expect, vi } from 'vitest'
import { createElectronUpdaterBackend, type AutoUpdaterLike } from '../electronUpdaterBackend'

/** Minimal EventEmitter-shaped stand-in for electron-updater's autoUpdater. */
function fakeAu(): AutoUpdaterLike & { emit: (e: string, arg?: unknown) => void } {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  return {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
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
    }
  }
}

describe('createElectronUpdaterBackend', () => {
  it('disables auto-download — this is what makes the flow notify-first', () => {
    const au = fakeAu()
    createElectronUpdaterBackend(au)
    expect(au.autoDownload).toBe(false)
    expect(au.autoInstallOnAppQuit).toBe(true)
    expect(au.allowPrerelease).toBe(false)
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
    const second = b.check()
    au.emit('update-available', { version: '2.0.0' })
    await expect(second).resolves.toEqual({ version: '2.0.0', notes: undefined })
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
