import { describe, it, expect } from 'vitest'
import { nextFireAfter } from '../schedule'
import type { RoutineSchedule } from '../../../../shared/routines'

/** Builds a local-time Date, so these assertions hold in any TZ the suite runs under. */
const local = (y: number, m: number, d: number, hh = 0, mm = 0): Date =>
  new Date(y, m - 1, d, hh, mm, 0, 0)

describe('nextFireAfter', () => {
  it('adds the interval', () => {
    expect(nextFireAfter({ kind: 'interval', everyMinutes: 240 }, local(2026, 8, 8, 1, 0))).toEqual(
      local(2026, 8, 8, 5, 0)
    )
  })

  it('returns today for a daily time still ahead', () => {
    expect(nextFireAfter({ kind: 'daily', at: '02:00' }, local(2026, 8, 8, 1, 30))).toEqual(
      local(2026, 8, 8, 2, 0)
    )
  })

  it('rolls to tomorrow once the daily time has passed', () => {
    expect(nextFireAfter({ kind: 'daily', at: '02:00' }, local(2026, 8, 8, 2, 30))).toEqual(
      local(2026, 8, 9, 2, 0)
    )
  })

  it('is strictly after: a fire computed from its own instant lands on the next one', () => {
    // The load-bearing case. If this returned the same instant, a run that starts exactly at
    // 02:00:00 would be due again the moment it finished, forever.
    expect(nextFireAfter({ kind: 'daily', at: '02:00' }, local(2026, 8, 8, 2, 0))).toEqual(
      local(2026, 8, 9, 2, 0)
    )
  })

  it('crosses a month boundary', () => {
    expect(nextFireAfter({ kind: 'daily', at: '02:00' }, local(2026, 8, 31, 3, 0))).toEqual(
      local(2026, 9, 1, 2, 0)
    )
  })

  it('picks the next allowed weekday', () => {
    // 2026-08-08 is a Saturday. Weekdays-only → Monday the 10th.
    expect(
      nextFireAfter({ kind: 'weekly', days: [1, 2, 3, 4, 5], at: '07:00' }, local(2026, 8, 8, 9, 0))
    ).toEqual(local(2026, 8, 10, 7, 0))
  })

  it('wraps a full week when today is the only allowed day and its time has passed', () => {
    // Saturday 09:00, schedule is Saturdays 07:00 → next Saturday, seven days on.
    expect(
      nextFireAfter({ kind: 'weekly', days: [6], at: '07:00' }, local(2026, 8, 8, 9, 0))
    ).toEqual(local(2026, 8, 15, 7, 0))
  })

  it('returns today when the allowed day is today and its time is still ahead', () => {
    expect(
      nextFireAfter({ kind: 'weekly', days: [6], at: '07:00' }, local(2026, 8, 8, 6, 0))
    ).toEqual(local(2026, 8, 8, 7, 0))
  })

  it('always moves forward', () => {
    // Property, not an example: whatever the schedule and whatever the instant, the answer is
    // in the future. This is what stops any schedule from re-firing in a tight loop.
    // NOT `as const` — that would make `days` a readonly tuple, which is not assignable to
    // RoutineSchedule's `number[]`.
    const schedules: RoutineSchedule[] = [
      { kind: 'interval', everyMinutes: 5 },
      { kind: 'daily', at: '02:00' },
      { kind: 'weekly', days: [6], at: '02:00' }
    ]
    const after = local(2026, 8, 8, 2, 0)
    for (const s of schedules) {
      expect(nextFireAfter(s, after).getTime()).toBeGreaterThan(after.getTime())
    }
  })

  it('throws on a hand-edited weekly schedule with no days', () => {
    // No cast needed: an empty `days` satisfies the TYPE (`number[]`) and is rejected only by
    // zod's `.min(1)` — which is exactly the gap a hand-edited routines.json slips through.
    expect(() =>
      nextFireAfter({ kind: 'weekly', days: [], at: '07:00' }, local(2026, 8, 8))
    ).toThrow(/no allowed day/i)
  })
})
