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
})
