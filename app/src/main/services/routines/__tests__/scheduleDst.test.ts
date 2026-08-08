import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { nextFireAfter } from '../schedule'

/**
 * Both DST transitions (spec §8), in a zone that has them.
 *
 * Its own file because it has to FORCE a timezone: schedule.ts does all its arithmetic in local
 * time, so every claim here is invisible under UTC and half of them are invisible in the
 * southern hemisphere. Node re-reads `process.env.TZ` for dates constructed after the
 * assignment, so setting it in `beforeAll` (and restoring it after, since a worker is reused
 * across files) is enough — every Date below is built inside a test.
 *
 * The first case asserts the zone actually took effect. Without it, a host that ignored the
 * override would make every remaining assertion pass vacuously, which is worse than no DST test
 * at all.
 *
 * These lock in what schedule.ts's doc comment promises rather than an ideal: a `02:30` daily on
 * a spring-forward day normalizes to 03:30 (02:30 does not exist), and on a fall-back day a time
 * inside the repeated hour fires ONCE, at its first occurrence. Both follow from
 * `new Date(y, m, d, hh, mm)` resolving DST the way the platform does, which is the deliberate
 * choice — the alternative is shipping a timezone database with a desktop app.
 */

const ORIGINAL_TZ = process.env.TZ

beforeAll(() => {
  process.env.TZ = 'America/New_York'
})
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

/** Local-time Date, the same shape schedule.ts builds its candidates with. */
const local = (y: number, m: number, d: number, hh = 0, mm = 0): Date =>
  new Date(y, m - 1, d, hh, mm, 0, 0)

/** `HH:MM`, offset-in-minutes, and weekday — the whole observable state of a fire. */
const at = (d: Date): { hhmm: string; offset: number; day: number; date: number } => ({
  hhmm: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  offset: d.getTimezoneOffset(),
  day: d.getDay(),
  date: d.getDate()
})

describe('nextFireAfter across DST', () => {
  it('is running in a zone that actually observes DST', () => {
    // EST = UTC-5 (300), EDT = UTC-4 (240). If this fails, the host did not honour the TZ
    // override and nothing below this line means anything.
    expect(local(2026, 1, 1).getTimezoneOffset()).toBe(300)
    expect(local(2026, 7, 1).getTimezoneOffset()).toBe(240)
  })

  describe('spring forward (2026-03-08, 02:00 EST → 03:00 EDT)', () => {
    it('normalizes a daily 02:30 to 03:30 on the day the hour is skipped', () => {
      const after = local(2026, 3, 8, 0, 30)
      const fire = nextFireAfter({ kind: 'daily', at: '02:30' }, after)
      expect(at(fire)).toMatchObject({ hhmm: '03:30', offset: 240, date: 8 })
      // Strictly-after still holds, which is what stops a normalized fire re-firing.
      expect(fire.getTime()).toBeGreaterThan(after.getTime())
    })

    it('normalizes the exactly-on-boundary 02:00 to 03:00', () => {
      const fire = nextFireAfter({ kind: 'daily', at: '02:00' }, local(2026, 3, 8, 0, 30))
      expect(at(fire)).toMatchObject({ hhmm: '03:00', offset: 240, date: 8 })
    })

    it('returns to the real 02:30 the next day', () => {
      // The normalization is confined to the one day that has no 02:30 — a schedule does not
      // drift an hour forever because of it.
      const fire = nextFireAfter({ kind: 'daily', at: '02:30' }, local(2026, 3, 8, 4, 0))
      expect(at(fire)).toMatchObject({ hhmm: '02:30', offset: 240, date: 9 })
    })

    it('keeps an interval exactly one hour of REAL time across the gap', () => {
      const after = local(2026, 3, 8, 1, 30)
      const fire = nextFireAfter({ kind: 'interval', everyMinutes: 60 }, after)
      expect(fire.getTime() - after.getTime()).toBe(60 * 60_000)
      // Which reads as 03:30 on the wall clock: an hour of elapsed time, two hours on the face.
      expect(at(fire)).toMatchObject({ hhmm: '03:30', offset: 240 })
    })

    it('files a normalized fire under the weekday it actually landed on', () => {
      // Sundays 02:30, evaluated the Saturday before. The candidate is built for Sunday and
      // normalizes to 03:30 the same day, so the day filter still accepts it.
      const fire = nextFireAfter(
        { kind: 'weekly', days: [0], at: '02:30' },
        local(2026, 3, 7, 12, 0)
      )
      expect(at(fire)).toMatchObject({ hhmm: '03:30', day: 0, date: 8 })
    })
  })

  describe('fall back (2026-11-01, 02:00 EDT → 01:00 EST)', () => {
    it('fires once inside the repeated hour, at its first occurrence', () => {
      const first = nextFireAfter({ kind: 'daily', at: '01:30' }, local(2026, 11, 1, 0, 30))
      // 01:30 happens twice that morning; this is the earlier one, still on daylight time.
      expect(at(first)).toMatchObject({ hhmm: '01:30', offset: 240, date: 1 })

      // And the second 01:30, an hour of real time later, is NOT a fire: the next one is
      // tomorrow. A schedule that fired twice here would run an unattended routine twice on
      // one night, once a year, with nobody watching.
      const next = nextFireAfter({ kind: 'daily', at: '01:30' }, first)
      expect(next.getTime()).not.toBe(first.getTime() + 60 * 60_000)
      expect(at(next)).toMatchObject({ hhmm: '01:30', offset: 300, date: 2 })
    })

    it('keeps an interval exactly one hour of REAL time across the repeat', () => {
      const after = nextFireAfter({ kind: 'daily', at: '01:30' }, local(2026, 11, 1, 0, 30))
      const fire = nextFireAfter({ kind: 'interval', everyMinutes: 60 }, after)
      expect(fire.getTime() - after.getTime()).toBe(60 * 60_000)
      // Same face time, the other side of the transition — an interval measures elapsed time,
      // so it lands in the repeated hour rather than skipping it.
      expect(at(fire)).toMatchObject({ hhmm: '01:30', offset: 300, date: 1 })
    })

    it('leaves a daily outside the repeated hour untouched', () => {
      const fire = nextFireAfter({ kind: 'daily', at: '02:30' }, local(2026, 11, 1, 0, 30))
      expect(at(fire)).toMatchObject({ hhmm: '02:30', offset: 300, date: 1 })
    })
  })
})
