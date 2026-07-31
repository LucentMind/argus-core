import { describe, it, expect, vi } from 'vitest'
import { registerUpdateIpc } from '../updateIpc'
import { CoreUpdaterService, type UpdaterBackend } from '../coreUpdater'
import { IPC } from '../../../../shared/ipc'

function harness(backend: Partial<UpdaterBackend> = {}) {
  const service = new CoreUpdaterService({
    backend: {
      check: vi.fn(async () => ({ version: '1.1.0' })),
      download: vi.fn(async () => {}),
      quitAndInstall: vi.fn(),
      onProgress: () => {},
      ...backend
    },
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
  return { service, handlers, broadcasts, off }
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
    const { handlers } = harness({ check: vi.fn(async () => { throw new Error('offline') }) })
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
})
