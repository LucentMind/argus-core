import { describe, it, expect, vi } from 'vitest'
import { registerCurrencyIpc } from '../currencyIpc'
import { IPC } from '../../../../../shared/ipc'
import type { CurrencyPayload } from '../../../../../shared/currency'

const payload: CurrencyPayload = { auto: true, lastSurveyAt: null, blocked: [], busy: false }

function fakeService(): {
  payload: () => CurrencyPayload
  surveyNow: (id: string) => Promise<void>
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

describe('registerCurrencyIpc', () => {
  it('serves the payload', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const service = fakeService()
    registerCurrencyIpc({
      handle: (ch, fn) => void handlers.set(ch, fn),
      broadcast: vi.fn(),
      service,
      anchors: fakeAnchors()
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
      anchors: fakeAnchors()
    })
    await handlers.get(IPC.currencySurveyNow)?.('hive')
    expect(service.surveyNow).toHaveBeenCalledWith('hive')
  })

  it('ignores an unknown adapter id instead of trusting the renderer', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const service = fakeService()
    registerCurrencyIpc({
      handle: (ch, fn) => void handlers.set(ch, fn),
      broadcast: vi.fn(),
      service,
      anchors: fakeAnchors()
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
      anchors: fakeAnchors()
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
      anchors: { firstMirrorNoticeShown: () => false, markFirstMirrorNoticeShown: mark }
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
      anchors: { firstMirrorNoticeShown: () => false, markFirstMirrorNoticeShown: mark }
    })
    await handlers.get(IPC.currencyGet)?.()
    await handlers.get(IPC.currencySurveyNow)?.('hive')
    expect(mark).not.toHaveBeenCalled()
  })
})
