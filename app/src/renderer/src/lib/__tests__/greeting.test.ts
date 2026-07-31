import { describe, it, expect } from 'vitest'
import { greetingFor } from '../greeting'

/** Local time — the greeting is about the user's clock, not UTC. */
function at(hour: number): Date {
  return new Date(2026, 7, 1, hour, 30, 0)
}

describe('greetingFor', () => {
  it('greets by local hour across the three buckets', () => {
    expect(greetingFor(at(5))).toBe('Good morning')
    expect(greetingFor(at(9))).toBe('Good morning')
    expect(greetingFor(at(12))).toBe('Good afternoon')
    expect(greetingFor(at(17))).toBe('Good afternoon')
    expect(greetingFor(at(18))).toBe('Good evening')
    expect(greetingFor(at(23))).toBe('Good evening')
  })

  // The bucket that wraps midnight — an `h < 18` afternoon test would pass at 02:00 and be wrong.
  it('folds the small hours into evening rather than into afternoon', () => {
    expect(greetingFor(at(0))).toBe('Good evening')
    expect(greetingFor(at(3))).toBe('Good evening')
    expect(greetingFor(at(4))).toBe('Good evening')
  })
})
