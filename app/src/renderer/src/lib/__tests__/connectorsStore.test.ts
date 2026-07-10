// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { connectorsStore } from '../connectorsStore'
import type { ConnectorsPayload } from '../../../../shared/connectors'

const payload = (over: Partial<ConnectorsPayload> = {}): ConnectorsPayload => ({
  connectors: {},
  runtime: {},
  oauth: {},
  loadError: null,
  secretsAvailable: true,
  secretsLoadError: null,
  ...over
})

let onChangedCb: ((p: ConnectorsPayload) => void) | null = null

beforeEach(() => {
  connectorsStore.reset()
  onChangedCb = null
  window.argus = {
    connectors: {
      get: vi.fn().mockResolvedValue(payload()),
      patch: vi.fn().mockResolvedValue(payload({ loadError: null })),
      test: vi.fn(),
      oauth: vi.fn(),
      onChanged: vi.fn((cb: (p: ConnectorsPayload) => void) => {
        onChangedCb = cb
        return () => {}
      })
    }
  } as never
})

describe('connectorsStore', () => {
  it('start fetches once and subscribes to pushes', async () => {
    connectorsStore.start()
    connectorsStore.start() // idempotent
    await vi.waitFor(() => expect(connectorsStore.get()).not.toBeNull())
    expect(window.argus.connectors.get).toHaveBeenCalledTimes(1)
    onChangedCb!(payload({ loadError: 'boom' }))
    expect(connectorsStore.get()?.loadError).toBe('boom')
  })

  it('start: get() rejection is caught, logged, and leaves the store null (no unhandled rejection)', async () => {
    const err = new Error('boom')
    ;(window.argus.connectors.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    connectorsStore.start()
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    expect(connectorsStore.get()).toBeNull()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('connectors load failed'), err)
    spy.mockRestore()
  })

  it('patch stores the returned payload; failure synthesizes a banner', async () => {
    connectorsStore.start()
    await vi.waitFor(() => expect(connectorsStore.get()).not.toBeNull())
    await connectorsStore.patch({ a: { kind: 'stdio', config: {} } })
    expect(window.argus.connectors.patch).toHaveBeenCalledWith({ a: { kind: 'stdio', config: {} } })
    ;(window.argus.connectors.patch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('nope')
    )
    await connectorsStore.patch({ b: null })
    const after = connectorsStore.get()!
    expect(after.loadError).toMatch(/connector save failed: .*nope/)
    // the rest of the payload survives the synthesized banner
    expect(after.connectors).toEqual({})
    expect(after.runtime).toEqual({})
    expect(after.oauth).toEqual({})
    expect(after.secretsAvailable).toBe(true)
    expect(after.secretsLoadError).toBeNull()
  })
})
