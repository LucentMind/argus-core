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

/**
 * Like `harness`, but the injected clock returns `clockValues[0]` on its FIRST call and
 * `clockValues[1]` on every call after that. `start()` calls `now()` once for `startedAt` and
 * then once more inside the immediate `tick()`, so this is what lets a test tell those two
 * instants apart — a plain constant clock makes them equal by construction and can't.
 */
const steppingHarness = (
  routines: RoutineDef[],
  nextRunAt: (r: RoutineDef) => string | null,
  clockValues: [Date, Date]
): {
  scheduler: RoutineScheduler
  calls: { id: string; trigger: RoutineTrigger }[]
} => {
  const calls: { id: string; trigger: RoutineTrigger }[] = []
  let callCount = 0
  const scheduler = new RoutineScheduler({
    store: { list: () => routines },
    service: {
      nextRunAt,
      enqueue: (r, trigger) => calls.push({ id: r.id, trigger })
    },
    now: () => clockValues[callCount++ === 0 ? 0 : 1]
  })
  return { scheduler, calls }
}

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

  it('labels a fire due after startedAt but before the tick as scheduled, not catchup', () => {
    // Regression coverage for a mutation that survived all prior tests: swapping
    // `startedAt.getTime()` for `now.getTime()` in the trigger check. With a constant clock
    // (every other test/harness here) `startedAt` and `now` are equal by construction, so that
    // mutation is invisible. A stepping clock separates them: `start()` reads `now()` once for
    // `startedAt` (T0), then `tick()` reads it again (T1 = T0 + 1h).
    const t0 = AT('2026-08-08T02:00:00.000Z')
    const t1 = AT('2026-08-08T03:00:00.000Z')
    // Due strictly between T0 and T1: the routine came due AFTER the scheduler started, so the
    // app was running for it — this must be 'scheduled'.
    const h = steppingHarness([routine()], () => '2026-08-08T02:30:00.000Z', [t0, t1])
    h.scheduler.start()
    h.scheduler.stop()
    // Correct code: due(02:30) < startedAt(02:00) is false -> 'scheduled'.
    // Mutated code (`now.getTime()` instead of `startedAt.getTime()`): due(02:30) < now(03:00)
    // is true -> 'catchup'. This assertion fails under that mutation.
    expect(h.calls).toHaveLength(1)
    expect(h.calls.map((c) => c.trigger)).toEqual(['scheduled'])
  })

  it('labels the immediate tick from start() as catchup when the fire predates start-up', () => {
    // Proves the catchup label through the real start()-driven path (not a bare tick() call):
    // nextRunAt is strictly before the instant start() captures as startedAt.
    const h = harness([routine()], () => '2026-08-08T01:00:00.000Z', AT('2026-08-08T02:00:00.000Z'))
    h.scheduler.start()
    h.scheduler.stop()
    expect(h.calls.map((c) => c.trigger)).toEqual(['catchup'])
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
