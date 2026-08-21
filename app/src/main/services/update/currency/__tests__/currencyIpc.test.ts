import { describe, it, expect, vi } from 'vitest'
import { registerCurrencyIpc } from '../currencyIpc'
import { IPC } from '../../../../../shared/ipc'
import type { CurrencyPayload } from '../../../../../shared/currency'

const payload: CurrencyPayload = { auto: true, lastSurveyAt: null, blocked: [], busy: false }

function fakeService(): {
  payload: () => CurrencyPayload
  surveyNow: (id: string, force?: boolean) => Promise<void>
  subscribe: (cb: (p: CurrencyPayload) => void) => () => void
  emit: (p: CurrencyPayload) => void
  listenerCount: () => number
} {
  const listeners: ((p: CurrencyPayload) => void)[] = []
  return {
    payload: vi.fn(() => payload),
    surveyNow: vi.fn(async () => {}),
    subscribe: (cb: (p: CurrencyPayload) => void) => {
      listeners.push(cb)
      return () => void listeners.splice(listeners.indexOf(cb), 1)
    },
    emit: (p: CurrencyPayload) => listeners.forEach((l) => l(p)),
    listenerCount: () => listeners.length
  }
}

const fakeAnchors = (): {
  firstMirrorNoticeShown: () => boolean
  markFirstMirrorNoticeShown: () => void
} => ({
  firstMirrorNoticeShown: () => false,
  markFirstMirrorNoticeShown: vi.fn()
})

const noPending = (): number => 0

describe('registerCurrencyIpc', () => {
  it('serves the payload', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const service = fakeService()
    registerCurrencyIpc({
      handle: (ch, fn) => void handlers.set(ch, fn),
      broadcast: vi.fn(),
      service,
      anchors: fakeAnchors(),
      pendingAdopted: noPending
    })
    expect(await handlers.get(IPC.currencyGet)?.()).toEqual(payload)
  })

  it('routes surveyNow to the named adapter', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const service = fakeService()
    registerCurrencyIpc({
      handle: (ch, fn) => void handlers.set(ch, fn),
      broadcast: vi.fn(),
      service,
      anchors: fakeAnchors(),
      pendingAdopted: noPending
    })
    await handlers.get(IPC.currencySurveyNow)?.('hive')
    // No force arg from the renderer ⇒ passed through as an explicit `false`, not omitted — see
    // the 'routes a forced survey through' test below for the other half of this.
    expect(service.surveyNow).toHaveBeenCalledWith('hive', false)
  })

  // Finding 3: the manual "Check for updates" button routes through `surveyNow('packs', true)` so
  // it works even when the adapter isn't due — this is the plumbing that makes `force` reach the
  // service.
  it('routes a forced survey through to the service', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const service = fakeService()
    registerCurrencyIpc({
      handle: (ch, fn) => void handlers.set(ch, fn),
      broadcast: vi.fn(),
      service,
      anchors: fakeAnchors(),
      pendingAdopted: noPending
    })
    await handlers.get(IPC.currencySurveyNow)?.('packs', true)
    expect(service.surveyNow).toHaveBeenCalledWith('packs', true)
  })

  it('ignores an unknown adapter id instead of trusting the renderer', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const service = fakeService()
    registerCurrencyIpc({
      handle: (ch, fn) => void handlers.set(ch, fn),
      broadcast: vi.fn(),
      service,
      anchors: fakeAnchors(),
      pendingAdopted: noPending
    })
    await handlers.get(IPC.currencySurveyNow)?.('../../etc')
    expect(service.surveyNow).not.toHaveBeenCalled()
  })

  it('broadcasts every change and the disposer stops it', () => {
    const broadcast = vi.fn()
    const service = fakeService()
    const dispose = registerCurrencyIpc({
      handle: vi.fn(),
      broadcast,
      service,
      anchors: fakeAnchors(),
      pendingAdopted: noPending
    })
    service.emit(payload)
    expect(broadcast).toHaveBeenCalledWith(IPC.currencyChanged, payload)
    dispose()
    expect(service.listenerCount()).toBe(0)
  })

  it('marks the first-run notice shown when the renderer acknowledges it', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const mark = vi.fn()
    registerCurrencyIpc({
      handle: (ch, fn) => void handlers.set(ch, fn),
      broadcast: vi.fn(),
      service: fakeService(),
      anchors: { firstMirrorNoticeShown: () => false, markFirstMirrorNoticeShown: mark },
      pendingAdopted: noPending
    })
    await handlers.get(IPC.currencyAckAdopted)?.()
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('does not mark it as a side effect of any other channel', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const mark = vi.fn()
    registerCurrencyIpc({
      handle: (ch, fn) => void handlers.set(ch, fn),
      broadcast: vi.fn(),
      service: fakeService(),
      anchors: { firstMirrorNoticeShown: () => false, markFirstMirrorNoticeShown: mark },
      pendingAdopted: noPending
    })
    await handlers.get(IPC.currencyGet)?.()
    await handlers.get(IPC.currencySurveyNow)?.('hive')
    expect(mark).not.toHaveBeenCalled()
  })

  // Finding 1: TopBar queries this once on the case-open transition, to recover a batch that
  // broadcast while nobody was subscribed to hear it.
  it('serves the pending-adopted count from its dep, not a hardcoded 0', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    registerCurrencyIpc({
      handle: (ch, fn) => void handlers.set(ch, fn),
      broadcast: vi.fn(),
      service: fakeService(),
      anchors: fakeAnchors(),
      pendingAdopted: () => 3
    })
    expect(await handlers.get(IPC.currencyPendingAdopted)?.()).toBe(3)
  })
})
