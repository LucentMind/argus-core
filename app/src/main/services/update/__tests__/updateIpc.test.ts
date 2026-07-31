import { describe, it, expect, vi } from 'vitest'
import { registerUpdateIpc } from '../updateIpc'
import { CoreUpdaterService, type UpdaterBackend } from '../coreUpdater'
import { IPC } from '../../../../shared/ipc'

interface HarnessFixture {
  service: CoreUpdaterService
  handlers: Map<string, () => unknown>
  broadcasts: Array<{ channel: string; payload: unknown }>
  off: () => void
  backend: UpdaterBackend
}

function harness(backendOverrides: Partial<UpdaterBackend> = {}): HarnessFixture {
  const backend = {
    check: vi.fn(async () => ({ version: '1.1.0' })),
    download: vi.fn(async () => {}),
    quitAndInstall: vi.fn(),
    onProgress: () => {},
    ...backendOverrides
  }
  const service = new CoreUpdaterService({
    backend,
    currentVersion: '1.0.8',
    supported: true
  })
  const handlers = new Map<string, () => unknown>()
  const broadcasts: Array<{ channel: string; payload: unknown }> = []
  const off = registerUpdateIpc({
    handle: (channel, fn) => void handlers.set(channel, fn),
    broadcast: (channel, payload) => void broadcasts.push({ channel, payload }),
    service
  })
  return { service, handlers, broadcasts, off, backend }
}

describe('registerUpdateIpc', () => {
  it('registers every update channel', () => {
    expect([...harness().handlers.keys()].sort()).toEqual(
      [IPC.updateStatus, IPC.updateCheck, IPC.updateDownload, IPC.updateRestart].sort()
    )
  })

  it('status returns the current payload', async () => {
    const { handlers } = harness()
    expect(await handlers.get(IPC.updateStatus)!()).toEqual({
      currentVersion: '1.0.8',
      status: { phase: 'idle' }
    })
  })

  it('the check handler runs a MANUAL check, so failures are surfaced', async () => {
    const { handlers } = harness({
      check: vi.fn(async () => {
        throw new Error('offline')
      })
    })
    const p = (await handlers.get(IPC.updateCheck)!()) as { status: { phase: string } }
    expect(p.status.phase).toBe('error')
  })

  it('broadcasts every transition on update:changed', async () => {
    const { handlers, broadcasts } = harness()
    await handlers.get(IPC.updateCheck)!()
    expect(broadcasts.map((b) => b.channel)).toEqual([IPC.updateChanged, IPC.updateChanged])
    expect(broadcasts.at(-1)!.payload).toEqual({
      currentVersion: '1.0.8',
      status: { phase: 'available', version: '1.1.0', notes: undefined }
    })
  })

  it('the returned disposer stops the broadcasts', async () => {
    const { handlers, broadcasts, off } = harness()
    off()
    await handlers.get(IPC.updateCheck)!()
    expect(broadcasts).toEqual([])
  })

  it('download handler reaches the download path', async () => {
    const { handlers } = harness()
    // Drive service to available state
    await handlers.get(IPC.updateCheck)!()
    // Invoke download handler
    const payload = (await handlers.get(IPC.updateDownload)!()) as {
      status: { phase: string; version?: string }
    }
    // Assert outcome reachable only through service.download()
    expect(payload.status).toEqual({ phase: 'ready', version: '1.1.0' })
  })

  it('restart handler reaches the restart path', async () => {
    const { handlers, backend } = harness()
    // Drive service to ready state (check → available, then download → ready)
    await handlers.get(IPC.updateCheck)!()
    await handlers.get(IPC.updateDownload)!()
    // Invoke restart handler
    handlers.get(IPC.updateRestart)!()
    // Assert backend's quitAndInstall was called exactly once
    expect(backend.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
