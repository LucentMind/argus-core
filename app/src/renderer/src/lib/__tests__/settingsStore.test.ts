// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SettingsStore } from '../settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'

function payload(overrides: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: {
      traceDir: { value: null, source: 'default' },
      parseBin: { value: null, source: 'default' }
    },
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null,
    ...overrides
  }
}

let onChangedCb: ((p: SettingsPayload) => void) | null = null

beforeEach(() => {
  onChangedCb = null
  window.argus = {
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async (p: unknown) => {
        const next = payload()
        Object.assign(next.settings.agent, (p as { agent?: object }).agent)
        return next
      }),
      onChanged: vi.fn((cb: (p: SettingsPayload) => void) => {
        onChangedCb = cb
        return () => {}
      })
    }
  } as never
})

describe('SettingsStore', () => {
  it('start() fetches the payload once and notifies subscribers', async () => {
    const store = new SettingsStore()
    let notified = 0
    store.subscribe(() => notified++)
    store.start()
    store.start() // idempotent
    await vi.waitFor(() => expect(store.get()).not.toBeNull())
    expect(window.argus.settings.get).toHaveBeenCalledTimes(1)
    expect(notified).toBe(1)
  })

  it('patch() forwards to IPC and applies the returned payload', async () => {
    const store = new SettingsStore()
    store.start()
    await vi.waitFor(() => expect(store.get()).not.toBeNull())
    await store.patch({ agent: { maxSessions: 7 } })
    expect(window.argus.settings.patch).toHaveBeenCalledWith({ agent: { maxSessions: 7 } })
    expect(store.get()!.settings.agent.maxSessions).toBe(7)
  })

  it('external settings:changed updates the store', async () => {
    const store = new SettingsStore()
    store.start()
    await vi.waitFor(() => expect(onChangedCb).not.toBeNull())
    const p = payload({ loadError: 'boom' })
    onChangedCb!(p)
    expect(store.get()!.loadError).toBe('boom')
  })

  it('patch() failure surfaces a loadError banner and notifies subscribers', async () => {
    const store = new SettingsStore()
    store.start()
    await vi.waitFor(() => expect(store.get()).not.toBeNull())
    let notified = 0
    store.subscribe(() => notified++)
    ;(window.argus.settings.patch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('disk full')
    )
    await store.patch({ agent: { maxSessions: 7 } })
    expect(store.get()!.loadError).toContain('save failed')
    expect(store.get()!.loadError).toContain('disk full')
    expect(notified).toBe(1)
  })
})
