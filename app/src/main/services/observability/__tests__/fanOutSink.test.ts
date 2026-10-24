import { describe, it, expect, vi } from 'vitest'
import { FanOutSink } from '../fanOutSink'
import type { ObservationSink } from '../sink'
import type { ObservationIntent } from '../intent'

function child(
  over: Partial<ObservationSink> = {}
): ObservationSink & { seen: ObservationIntent[] } {
  const seen: ObservationIntent[] = []
  return {
    seen,
    emit: (i) => {
      seen.push(...i)
    },
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    ...over
  }
}
const score: ObservationIntent = { kind: 'score', seed: 's', name: 'n', value: 1 }

describe('FanOutSink', () => {
  it('forwards every intent to every child', () => {
    const a = child()
    const b = child()
    new FanOutSink([a, b]).emit([score, score])
    expect(a.seen).toHaveLength(2)
    expect(b.seen).toHaveLength(2)
  })

  it('a throwing child never starves the others and latches its error', () => {
    const bad = child({
      emit: () => {
        throw new Error('boom')
      }
    })
    const good = child()
    const fan = new FanOutSink([bad, good])
    expect(() => fan.emit([score])).not.toThrow()
    expect(good.seen).toHaveLength(1)
    expect(fan.childErrors()).toEqual(['boom', null])
    expect(fan.lastError()).toBe('boom')
  })

  it('flush waits for all children even when one rejects; shutdown is idempotent', async () => {
    const slow = child({
      flush: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    })
    const bad = child({
      flush: vi.fn(async () => {
        throw new Error('flush-fail')
      })
    })
    const fan = new FanOutSink([slow, bad])
    await expect(fan.flush()).resolves.toBeUndefined()
    expect(slow.flush).toHaveBeenCalled()
    expect(fan.childErrors()[1]).toBe('flush-fail')
    await fan.shutdown()
    await fan.shutdown()
    expect(slow.shutdown).toHaveBeenCalledTimes(1)
  })

  it('a synchronously throwing flush or shutdown never rejects the fan-out and is latched', async () => {
    const bad = child({
      flush: vi.fn(() => {
        throw new Error('sync-flush')
      }) as unknown as ObservationSink['flush'],
      shutdown: vi.fn(() => {
        throw new Error('sync-shutdown')
      }) as unknown as ObservationSink['shutdown']
    })
    const good = child()
    const fan = new FanOutSink([bad, good])
    await expect(fan.flush()).resolves.toBeUndefined()
    expect(good.flush).toHaveBeenCalled()
    expect(fan.childErrors()).toEqual(['sync-flush', null])
    await expect(fan.shutdown()).resolves.toBeUndefined()
    expect(good.shutdown).toHaveBeenCalled()
    expect(fan.childErrors()[0]).toBe('sync-shutdown')
  })

  it('a rejecting shutdown is latched like a rejecting flush', async () => {
    const bad = child({
      shutdown: vi.fn(async () => {
        throw new Error('shutdown-fail')
      })
    })
    const fan = new FanOutSink([bad, child()])
    await expect(fan.shutdown()).resolves.toBeUndefined()
    expect(fan.childErrors()).toEqual(['shutdown-fail', null])
  })

  it('emit after shutdown is a no-op on every child', async () => {
    const a = child()
    const b = child()
    const fan = new FanOutSink([a, b])
    await fan.shutdown()
    fan.emit([score])
    expect(a.seen).toHaveLength(0)
    expect(b.seen).toHaveLength(0)
  })

  it("childErrors falls back to a child's own lastError when the fan-out caught nothing", () => {
    const own = child({ lastError: () => 'own-error' })
    const fan = new FanOutSink([own, child()])
    expect(fan.childErrors()).toEqual(['own-error', null])
    expect(fan.lastError()).toBe('own-error')
  })
})
