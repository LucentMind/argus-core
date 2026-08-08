import { describe, it, expect, vi } from 'vitest'
import { RoutineScheduler } from '../scheduler'
import type { RoutineDef, RoutineTrigger } from '../../../../shared/routines'

const routine = (over: Partial<RoutineDef> = {}): RoutineDef =>
  ({
    id: 'sweep',
    name: 'Sweep',
    prompt: 'p',
    timeoutMs: 600_000,
    enabled: true,
    schedule: { kind: 'interval', everyMinutes: 60 },
    ...over
  }) as RoutineDef

/** A scheduler over a fixed routine list, a scripted nextRunAt, and a recording enqueue. */
const harness = (
  routines: RoutineDef[],
  nextRunAt: (r: RoutineDef) => string | null,
  now: Date
): {
  scheduler: RoutineScheduler
  calls: { id: string; trigger: RoutineTrigger }[]
  setNow: (d: Date) => void
} => {
  const calls: { id: string; trigger: RoutineTrigger }[] = []
  let clock = now
  const scheduler = new RoutineScheduler({
    store: { list: () => routines },
    service: {
      nextRunAt,
      enqueue: (r, trigger) => calls.push({ id: r.id, trigger })
    },
    now: () => clock
  })
  return { scheduler, calls, setNow: (d) => (clock = d) }
}

const AT = (iso: string): Date => new Date(iso)

describe('RoutineScheduler', () => {
  it('enqueues a routine whose next fire has passed', () => {
    const h = harness([routine()], () => '2026-08-08T01:00:00.000Z', AT('2026-08-08T02:00:00.000Z'))
    h.scheduler.tick()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].id).toBe('sweep')
  })

  it('leaves a routine whose fire is still ahead alone', () => {
    const h = harness([routine()], () => '2026-08-08T03:00:00.000Z', AT('2026-08-08T02:00:00.000Z'))
    h.scheduler.tick()
    expect(h.calls).toEqual([])
  })

  it('skips a routine with no next fire (manual-only or disabled)', () => {
    // nextRunAt already folds in both rules; the scheduler must not second-guess it.
    const h = harness([routine()], () => null, AT('2026-08-08T02:00:00.000Z'))
    h.scheduler.tick()
    expect(h.calls).toEqual([])
  })

  it('labels a fire missed before start-up as catchup, once', () => {
    const h = harness([routine()], () => '2026-08-07T02:00:00.000Z', AT('2026-08-08T09:00:00.000Z'))
    h.scheduler.tick()
    h.scheduler.tick()
    expect(h.calls.map((c) => c.trigger)).toEqual(['catchup', 'scheduled'])
  })

  it('does not call a fire the scheduler was up for a catch-up, even on the first tick', () => {
    // Start instant and due instant are the same: Argus was running for it. `catchup` is
    // reserved for fires the app was CLOSED for, and this is the boundary that decides.
    const h = harness([routine()], () => '2026-08-08T02:00:00.000Z', AT('2026-08-08T02:00:00.000Z'))
    h.scheduler.tick()
    expect(h.calls[0].trigger).toBe('scheduled')
  })

  it('labels a fire that came due after start-up as scheduled', () => {
    const h = harness([routine()], () => '2026-08-08T02:30:00.000Z', AT('2026-08-08T02:00:00.000Z'))
    h.scheduler.start() // startedAt = 02:00; the fire is still ahead, so nothing is enqueued
    h.scheduler.stop()
    expect(h.calls).toEqual([])
    h.setNow(AT('2026-08-08T03:00:00.000Z'))
    h.scheduler.tick()
    expect(h.calls.map((c) => c.trigger)).toEqual(['scheduled'])
  })

  it('start runs a tick immediately, then on the interval', () => {
    vi.useFakeTimers()
    try {
      const calls: { id: string; trigger: RoutineTrigger }[] = []
      const scheduler = new RoutineScheduler({
        store: { list: () => [routine()] },
        service: {
          nextRunAt: () => '2026-08-01T00:00:00.000Z',
          enqueue: (r, trigger) => calls.push({ id: r.id, trigger })
        },
        now: () => new Date('2026-08-08T02:00:00.000Z'),
        tickMs: 1000
      })
      scheduler.start()
      expect(calls).toHaveLength(1)
      vi.advanceTimersByTime(2500)
      expect(calls).toHaveLength(3)
      scheduler.stop()
      vi.advanceTimersByTime(5000)
      expect(calls).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('start is idempotent', () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const scheduler = new RoutineScheduler({
        store: { list: () => [routine()] },
        service: { nextRunAt: () => '2026-08-01T00:00:00.000Z', enqueue: (r) => calls.push(r.id) },
        now: () => new Date('2026-08-08T02:00:00.000Z'),
        tickMs: 1000
      })
      scheduler.start()
      scheduler.start()
      calls.length = 0
      vi.advanceTimersByTime(1000)
      // Two intervals would mean two ticks per second — and, worse, no handle on the first.
      expect(calls).toHaveLength(1)
      scheduler.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a throwing nextRunAt does not stop the other routines', () => {
    const calls: string[] = []
    const scheduler = new RoutineScheduler({
      store: { list: () => [routine({ id: 'bad' }), routine({ id: 'good' })] },
      service: {
        nextRunAt: (r) => {
          if (r.id === 'bad') throw new Error('hand-edited schedule')
          return '2026-08-01T00:00:00.000Z'
        },
        enqueue: (r) => calls.push(r.id)
      },
      now: () => new Date('2026-08-08T02:00:00.000Z')
    })
    // nextFireAfter throws on a schedule that got past the schema by hand. One broken routine
    // must not silence every other routine's schedule for the rest of the session.
    expect(() => scheduler.tick()).not.toThrow()
    expect(calls).toEqual(['good'])
  })
})
