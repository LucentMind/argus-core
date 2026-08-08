import type { RoutineSchedule } from '../../../shared/routines'

// Deliberately imports NO electron and touches no I/O: pure arithmetic, so the whole surface is
// unit-testable and a future headless host can use it unchanged.

/**
 * The next instant this schedule fires, STRICTLY after `after`.
 *
 * Strictly-after is the contract that matters. Every caller passes either the routine's last
 * attempt or the scheduler's start instant, and a schedule that could return `after` itself
 * would be due again the instant it fired — a tight unattended loop.
 *
 * All arithmetic is LOCAL: `new Date(y, m, d, hh, mm)` resolves DST the way the platform does.
 * On a spring-forward day a `02:30` daily normalizes to 03:30; on fall-back it fires once at
 * the first 02:30. Accepted and documented rather than corrected — the alternative is shipping
 * a timezone database for a desktop app whose user is in one place.
 */
export function nextFireAfter(schedule: RoutineSchedule, after: Date): Date {
  if (schedule.kind === 'interval') {
    // Unreachable for a schema-validated schedule (`everyMinutes` is positive). Reachable via a
    // hand-edited config/routines.json, where returning early or looping would be worse.
    if (schedule.everyMinutes <= 0) {
      throw new Error('Schedule interval must be positive: everyMinutes must be greater than 0')
    }
    return new Date(after.getTime() + schedule.everyMinutes * 60_000)
  }
  const [hh, mm] = schedule.at.split(':').map(Number)
  const days = schedule.kind === 'weekly' ? new Set(schedule.days) : null
  return nextLocalTimeAfter(after, hh, mm, days)
}

/**
 * Walks forward one local calendar day at a time from `after`'s date.
 *
 * Eight candidates (today plus a full week) is exactly enough: a weekly schedule with any
 * allowed day always lands inside that window, including the worst case where today is the
 * only allowed day and its time has already passed.
 *
 * `getDay()` is read off the CONSTRUCTED date rather than tracked alongside the offset, so a
 * DST normalization that pushes the instant across midnight is still filtered against the day
 * it actually landed on.
 */
function nextLocalTimeAfter(
  after: Date,
  hh: number,
  mm: number,
  days: Set<number> | null
): Date {
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(
      after.getFullYear(),
      after.getMonth(),
      after.getDate() + offset,
      hh,
      mm,
      0,
      0
    )
    if (candidate.getTime() <= after.getTime()) continue
    if (days && !days.has(candidate.getDay())) continue
    return candidate
  }
  // Unreachable for a schema-validated schedule (`days` is non-empty). Reachable via a
  // hand-edited config/routines.json, where returning undefined or looping would be worse.
  throw new Error('Schedule has no allowed day: no fire within 8 days')
}
