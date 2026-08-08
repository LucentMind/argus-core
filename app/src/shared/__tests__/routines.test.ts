import { describe, it, expect } from 'vitest'
import {
  routineSchema,
  routinesFileSchema,
  defaultRoutines,
  MAX_TIMEOUT_MS,
  MAX_TIMEOUT_MINUTES,
  scheduleSchema,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES
} from '../routines'

describe('routine schema', () => {
  it('applies defaults for timeoutMs and enabled', () => {
    const r = routineSchema.parse({ id: 'nightly-sweep', name: 'Nightly sweep', prompt: 'do it' })
    expect(r.timeoutMs).toBe(600_000)
    expect(r.enabled).toBe(true)
  })

  it('rejects ids that are not case-slug-safe', () => {
    expect(() => routineSchema.parse({ id: 'Has Spaces', name: 'x', prompt: 'y' })).toThrow()
  })

  it('parses an empty file to defaults', () => {
    expect(routinesFileSchema.parse({})).toEqual(defaultRoutines())
  })

  /**
   * The id-length boundary, both sides.
   *
   * The bound is not arbitrary and its failure is not local: the id becomes `routine-<id>` (8 + n
   * chars) in caseService's slug, whose SLUG_RE tops out at 64 — so 56 is the largest id that can
   * ever produce a legal case slug. Widening the regex would compile clean, pass every other test,
   * and only surface at run time in a different module, as `createCase` rejecting a routine the
   * user already saved. These two cases are what make an accidental widening go red HERE.
   */
  describe('id length is bounded so `routine-<id>` fits a 64-char case slug', () => {
    const idOf = (n: number): string => 'a'.repeat(n)

    it('accepts the longest id that still fits (56)', () => {
      const id = idOf(56)
      expect(routineSchema.parse({ id, name: 'x', prompt: 'y' }).id).toBe(id)
      // The reason the cap is 56 and not something else, asserted rather than described.
      expect(`routine-${id}`.length).toBe(64)
    })

    it('rejects one character more (57)', () => {
      expect(() => routineSchema.parse({ id: idOf(57), name: 'x', prompt: 'y' })).toThrow()
    })
  })

  describe('timeoutMs is capped', () => {
    it('accepts exactly the cap', () => {
      const r = routineSchema.parse({ id: 'a', name: 'x', prompt: 'y', timeoutMs: MAX_TIMEOUT_MS })
      expect(r.timeoutMs).toBe(MAX_TIMEOUT_MS)
      expect(MAX_TIMEOUT_MS).toBe(MAX_TIMEOUT_MINUTES * 60_000)
    })

    it('rejects one millisecond over, and says what the limit is', () => {
      // A hand-edited config must not be able to buy a run longer than the UI allows —
      // increment 1 has no cancel, so an over-long turn cannot be stopped.
      expect(() =>
        routineSchema.parse({ id: 'a', name: 'x', prompt: 'y', timeoutMs: MAX_TIMEOUT_MS + 1 })
      ).toThrow(new RegExp(`at most ${MAX_TIMEOUT_MINUTES} minutes`))
    })
  })
})

describe('schedule schema', () => {
  it('accepts the three kinds', () => {
    expect(scheduleSchema.parse({ kind: 'interval', everyMinutes: 240 })).toEqual({
      kind: 'interval',
      everyMinutes: 240
    })
    expect(scheduleSchema.parse({ kind: 'daily', at: '02:00' })).toEqual({
      kind: 'daily',
      at: '02:00'
    })
    expect(scheduleSchema.parse({ kind: 'weekly', days: [1, 2, 3, 4, 5], at: '07:00' })).toEqual({
      kind: 'weekly',
      days: [1, 2, 3, 4, 5],
      at: '07:00'
    })
  })

  /**
   * Both ends of `everyMinutes`, and integrality.
   *
   * Neither bound is cosmetic and neither fails where it is set. The floor is what stops a
   * routine whose turn outlives its own period from holding the single serial execution slot
   * continuously and starving every other routine. The ceiling is the value that pairs with the
   * persisted schedule anchor (anchors.ts): one week is the longest first fire the engine has to
   * carry across restarts, and widening it silently widens that. A non-integer would reach
   * `after.getTime() + everyMinutes * 60_000` and produce fires on fractional milliseconds.
   */
  describe('everyMinutes is bounded at both ends and whole', () => {
    it('accepts exactly the floor and exactly the ceiling', () => {
      expect(
        scheduleSchema.parse({ kind: 'interval', everyMinutes: MIN_INTERVAL_MINUTES })
      ).toEqual({ kind: 'interval', everyMinutes: MIN_INTERVAL_MINUTES })
      expect(
        scheduleSchema.parse({ kind: 'interval', everyMinutes: MAX_INTERVAL_MINUTES })
      ).toEqual({ kind: 'interval', everyMinutes: MAX_INTERVAL_MINUTES })
      // The ceiling is one week, asserted rather than described.
      expect(MAX_INTERVAL_MINUTES).toBe(7 * 24 * 60)
    })

    it('rejects one minute past the ceiling', () => {
      expect(() =>
        scheduleSchema.parse({ kind: 'interval', everyMinutes: MAX_INTERVAL_MINUTES + 1 })
      ).toThrow()
    })

    it('rejects a fractional interval that sits inside the range', () => {
      // 4.5 is under the floor; 5.5 is not, so this is the case that only integrality rejects.
      expect(() => scheduleSchema.parse({ kind: 'interval', everyMinutes: 4.5 })).toThrow()
      expect(() => scheduleSchema.parse({ kind: 'interval', everyMinutes: 5.5 })).toThrow()
    })
  })

  it('rejects an interval under the floor', () => {
    expect(() =>
      scheduleSchema.parse({ kind: 'interval', everyMinutes: MIN_INTERVAL_MINUTES - 1 })
    ).toThrow()
  })

  it('rejects a malformed or out-of-range time', () => {
    expect(() => scheduleSchema.parse({ kind: 'daily', at: '2:00' })).toThrow()
    expect(() => scheduleSchema.parse({ kind: 'daily', at: '24:00' })).toThrow()
    expect(() => scheduleSchema.parse({ kind: 'daily', at: '02:60' })).toThrow()
  })

  it('rejects a weekly schedule with no days', () => {
    expect(() => scheduleSchema.parse({ kind: 'weekly', days: [], at: '07:00' })).toThrow()
  })

  it('rejects a day outside 0..6', () => {
    expect(() => scheduleSchema.parse({ kind: 'weekly', days: [7], at: '07:00' })).toThrow()
  })

  it('leaves a routine without a schedule valid, and round-trips one with', () => {
    const manual = routineSchema.parse({ id: 'a', name: 'A', prompt: 'p' })
    expect(manual.schedule).toBeUndefined()
    const scheduled = routineSchema.parse({
      id: 'b',
      name: 'B',
      prompt: 'p',
      schedule: { kind: 'daily', at: '02:00' }
    })
    expect(scheduled.schedule).toEqual({ kind: 'daily', at: '02:00' })
  })
})
