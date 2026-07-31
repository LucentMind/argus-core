import { describe, it, expect, vi } from 'vitest'
import { CoreUpdaterService, type UpdaterBackend } from '../coreUpdater'
import type { CoreUpdatePayload } from '../../../../shared/updates'

function fakeBackend(over: Partial<UpdaterBackend> = {}): UpdaterBackend & {
  emitProgress: (p: number) => void
} {
  const progress: Array<(p: number) => void> = []
  return {
    check: vi.fn(async () => null),
    download: vi.fn(async () => {}),
    quitAndInstall: vi.fn(),
    onProgress: (cb) => void progress.push(cb),
    emitProgress: (p) => progress.forEach((cb) => cb(p)),
    ...over
  }
}

const svc = (backend: UpdaterBackend, supported = true): CoreUpdaterService =>
  new CoreUpdaterService({ backend, currentVersion: '1.0.8', supported, now: () => 1000 })

describe('CoreUpdaterService', () => {
  it('starts idle and reports the current version', () => {
    expect(svc(fakeBackend()).payload()).toEqual({
      currentVersion: '1.0.8',
      status: { phase: 'idle' }
    })
  })

  it('is unsupported in an unpackaged build and never calls the backend', async () => {
    const b = fakeBackend()
    const s = svc(b, false)
    expect(s.payload().status.phase).toBe('unsupported')
    await s.check({ manual: true })
    expect(b.check).not.toHaveBeenCalled()
  })

  it('goes to available when the backend finds a newer version', async () => {
    const b = fakeBackend({ check: vi.fn(async () => ({ version: '1.1.0', notes: 'fixes' })) })
    expect((await svc(b).check({ manual: true })).status).toEqual({
      phase: 'available',
      version: '1.1.0',
      notes: 'fixes'
    })
  })

  it('returns to idle when there is nothing newer', async () => {
    expect((await svc(fakeBackend()).check({ manual: true })).status).toEqual({ phase: 'idle' })
  })

  it('a failed BOOT check falls back to idle and is not surfaced as an error', async () => {
    const b = fakeBackend({
      check: vi.fn(async () => {
        throw new Error('ENOTFOUND')
      })
    })
    expect((await svc(b).check({ manual: false })).status).toEqual({ phase: 'idle' })
  })

  it('a failed MANUAL check reports the error', async () => {
    const b = fakeBackend({
      check: vi.fn(async () => {
        throw new Error('ENOTFOUND')
      })
    })
    expect((await svc(b).check({ manual: true })).status).toEqual({
      phase: 'error',
      message: 'ENOTFOUND',
      at: 1000
    })
  })

  it('download moves available → ready, carrying the version across', async () => {
    const b = fakeBackend({ check: vi.fn(async () => ({ version: '1.1.0' })) })
    const s = svc(b)
    await s.check({ manual: true })
    expect((await s.download()).status).toEqual({ phase: 'ready', version: '1.1.0' })
  })

  it('download is a no-op unless an update is available', async () => {
    const b = fakeBackend()
    await svc(b).download()
    expect(b.download).not.toHaveBeenCalled()
  })

  it('progress updates percent only while downloading, never after ready', async () => {
    let release: () => void = () => {}
    const b = fakeBackend({
      check: vi.fn(async () => ({ version: '1.1.0' })),
      download: vi.fn(
        () =>
          new Promise<void>((r) => {
            release = r
          })
      )
    })
    const s = svc(b)
    await s.check({ manual: true })
    const pending = s.download()
    b.emitProgress(42)
    expect(s.payload().status).toEqual({ phase: 'downloading', percent: 42 })
    release()
    await pending
    b.emitProgress(99)
    expect(s.payload().status).toEqual({ phase: 'ready', version: '1.1.0' })
  })

  it('restart only installs once bytes are staged', async () => {
    const b = fakeBackend({ check: vi.fn(async () => ({ version: '1.1.0' })) })
    const s = svc(b)
    s.restart()
    expect(b.quitAndInstall).not.toHaveBeenCalled()
    await s.check({ manual: true })
    await s.download()
    s.restart()
    expect(b.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('a restart whose quitAndInstall throws reports the error, mirroring check/download', async () => {
    const b = fakeBackend({
      check: vi.fn(async () => ({ version: '1.1.0' })),
      quitAndInstall: vi.fn(() => {
        throw new Error('installer failed to spawn')
      })
    })
    const s = svc(b)
    await s.check({ manual: true })
    await s.download()
    expect(s.restart().status).toEqual({
      phase: 'error',
      message: 'installer failed to spawn',
      at: 1000
    })
  })

  it('notifies subscribers on every transition and stops after unsubscribe', async () => {
    const b = fakeBackend({ check: vi.fn(async () => ({ version: '1.1.0' })) })
    const s = svc(b)
    const seen: CoreUpdatePayload[] = []
    const off = s.subscribe((p) => void seen.push(p))
    await s.check({ manual: true })
    expect(seen.map((p) => p.status.phase)).toEqual(['checking', 'available'])
    off()
    await s.download()
    expect(seen).toHaveLength(2)
  })

  it('check() is a no-op when ready, preserving the staged update', async () => {
    const b = fakeBackend({ check: vi.fn(async () => ({ version: '1.1.0' })) })
    const s = svc(b)
    await s.check({ manual: true })
    await s.download()
    const beforeCheck = s.payload().status
    expect(beforeCheck).toEqual({ phase: 'ready', version: '1.1.0' })
    // Call check again while ready
    await s.check({ manual: true })
    // Backend should not have been called a second time
    expect(b.check).toHaveBeenCalledOnce()
    // Status should still be ready with the same version
    expect(s.payload().status).toEqual({ phase: 'ready', version: '1.1.0' })
  })

  it('re-entrancy guard prevents concurrent check() calls', async () => {
    let release: (v: null) => void = () => {}
    const b = fakeBackend({
      check: vi.fn(
        (): Promise<null> =>
          new Promise((r) => {
            release = r
          })
      )
    })
    const s = svc(b)
    // Start first check but don't await it
    const firstCheck = s.check({ manual: true })
    // Synchronously call check again (should be guarded)
    await s.check({ manual: true })
    // Backend should only have been called once, not twice
    expect(b.check).toHaveBeenCalledOnce()
    // Resolve the first check
    release(null)
    await firstCheck
  })

  it('handles non-Error rejections by converting to string message', async () => {
    const b = fakeBackend({
      check: vi.fn(async () => {
        throw 'boom'
      })
    })
    const result = await svc(b).check({ manual: true })
    expect(result.status).toEqual({
      phase: 'error',
      message: 'boom',
      at: 1000
    })
  })
})
