import { describe, it, expect, vi } from 'vitest'
import { createCoreAdapter, type CoreUpdaterLike } from '../coreAdapter'
import type { CoreUpdatePayload, UpdateStatus } from '../../../../../shared/updates'

const payloadWith = (status: UpdateStatus): CoreUpdatePayload => ({
  currentVersion: '2.2.0',
  status,
  channel: 'stable'
})

function fakeService(status: UpdateStatus, over: Partial<CoreUpdaterLike> = {}): CoreUpdaterLike {
  return {
    payload: () => payloadWith(status),
    check: vi.fn(async () => payloadWith(status)),
    download: vi.fn(async () => payloadWith({ phase: 'ready', version: '2.3.0' })),
    ...over
  }
}

describe('coreAdapter.survey', () => {
  it('offers a found version as clean', async () => {
    const svc = fakeService({ phase: 'available', version: '2.3.0' })
    expect(await createCoreAdapter({ service: svc }).survey()).toEqual([
      {
        domain: 'core',
        key: 'core',
        label: 'Argus',
        from: '2.2.0',
        to: '2.3.0',
        verdict: 'clean'
      }
    ])
  })

  it('returns nothing when already current', async () => {
    expect(await createCoreAdapter({ service: fakeService({ phase: 'idle' }) }).survey()).toEqual(
      []
    )
  })

  it('blocks a downgrade rather than applying it', async () => {
    const svc = fakeService({ phase: 'available', version: '2.1.0', downgrade: true })
    const [c] = await createCoreAdapter({ service: svc }).survey()
    expect(c.verdict).toBe('blocked')
    expect(c.reason).toEqual({ kind: 'downgrade' })
  })

  it('blocks an unpackaged build and never calls check', async () => {
    const check = vi.fn(async () => payloadWith({ phase: 'unsupported', reason: 'no' }))
    const svc = fakeService({ phase: 'unsupported', reason: 'no' }, { check })
    const [c] = await createCoreAdapter({ service: svc }).survey()
    expect(c.reason).toEqual({ kind: 'unsupported' })
    expect(check).not.toHaveBeenCalled()
  })

  it('does not re-check while a download is already staged', async () => {
    const check = vi.fn(async () => payloadWith({ phase: 'ready', version: '2.3.0' }))
    const svc = fakeService({ phase: 'ready', version: '2.3.0' }, { check })
    expect(await createCoreAdapter({ service: svc }).survey()).toEqual([])
    expect(check).not.toHaveBeenCalled()
  })

  it('does not re-check while a download is in flight', async () => {
    const check = vi.fn(async () => payloadWith({ phase: 'downloading', percent: 42 }))
    const svc = fakeService({ phase: 'downloading', percent: 42 }, { check })
    expect(await createCoreAdapter({ service: svc }).survey()).toEqual([])
    expect(check).not.toHaveBeenCalled()
  })

  it('does not re-check while a check is already in flight', async () => {
    const check = vi.fn(async () => payloadWith({ phase: 'checking' }))
    const svc = fakeService({ phase: 'checking' }, { check })
    expect(await createCoreAdapter({ service: svc }).survey()).toEqual([])
    expect(check).not.toHaveBeenCalled()
  })

  it('surveys silently — a failed check is never a manual one', async () => {
    const check = vi.fn(async () => payloadWith({ phase: 'idle' }))
    const svc = fakeService({ phase: 'idle' }, { check })
    await createCoreAdapter({ service: svc }).survey()
    expect(check).toHaveBeenCalledWith({ manual: false })
  })
})

describe('coreAdapter.apply', () => {
  it('downloads and reports that a restart is needed', async () => {
    const svc = fakeService({ phase: 'available', version: '2.3.0' })
    const adapter = createCoreAdapter({ service: svc })
    const [c] = await adapter.survey()
    expect(await adapter.apply(c)).toEqual({ ok: true, needsRestart: true })
    expect(svc.download).toHaveBeenCalledTimes(1)
  })

  it('reports failure when the download errors', async () => {
    const download = vi.fn(async () =>
      payloadWith({ phase: 'error', message: 'connection reset', at: 1 })
    )
    const svc = fakeService({ phase: 'available', version: '2.3.0' }, { download })
    const adapter = createCoreAdapter({ service: svc })
    const [c] = await adapter.survey()
    expect(await adapter.apply(c)).toEqual({ ok: false, error: 'connection reset' })
  })

  it("does not claim success when the world moved and download no-op'd", async () => {
    // Simulates CoreUpdaterService.download()'s no-op: the phase was no longer `available` by the
    // time apply ran (e.g. Settings' "Check for updates" reached the service directly, outside
    // the apply lock), so download() returned the current payload unchanged instead of staging.
    const download = vi.fn(async () => payloadWith({ phase: 'idle' }))
    const svc = fakeService({ phase: 'available', version: '2.3.0' }, { download })
    const adapter = createCoreAdapter({ service: svc })
    const [c] = await adapter.survey()
    const outcome = await adapter.apply(c)
    expect(outcome.ok).toBe(false)
    expect(outcome).not.toHaveProperty('reason')
  })
})
