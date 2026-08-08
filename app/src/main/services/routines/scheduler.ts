import type { RoutineDef, RoutineTrigger } from '../../../shared/routines'

// Deliberately imports NO electron (same rule as service.ts and background.ts): the routines
// engine must stay pure Node so a future headless server can host it.

export interface RoutineSchedulerDeps {
  /** Structural, not the RoutineStore class — the tests need no file on disk. */
  store: { list: () => RoutineDef[] }
  /** Structural, not RoutinesService — the tests need no driver and no database. */
  service: {
    nextRunAt: (routine: RoutineDef) => string | null
    enqueue: (routine: RoutineDef, trigger: RoutineTrigger) => void
  }
  now?: () => Date
  /** Poll period. 30s in production; tests pass something small with fake timers. */
  tickMs?: number
}

const DEFAULT_TICK_MS = 30_000

/**
 * Fires due routines by POLLING the wall clock, not by arming a timer for each next fire.
 *
 * A `setTimeout` armed for the exact instant breaks three ways that all actually happen on a
 * laptop — system suspend, a DST shift, and the user changing the clock — and each needs its own
 * detection and re-arm path, plus a teardown and re-arm every time config/routines.json is
 * edited. A poll has one path and self-heals from all of them, because it only ever asks
 * "is the next fire in the past". The price is up to one tick of lateness on schedules measured
 * in hours.
 *
 * It also makes CATCH-UP the same code as ordinary firing. After an overnight shutdown the
 * routine's anchor is yesterday's run and its next fire is this morning — already past — so it
 * is due on the first tick. Because `nextRunAt` computes ONE next fire from the anchor rather
 * than enumerating missed occurrences, a week-long shutdown produces one run, not seven. The
 * `catchup` label below is the only thing catch-up adds.
 *
 * Owns no state about runs: `nextRunAt` and `enqueue` are the whole interface to the engine.
 */
export class RoutineScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt: Date | null = null
  private firstTick = true

  constructor(private deps: RoutineSchedulerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /** Ticks immediately (this is the catch-up pass), then every `tickMs`. Idempotent. */
  start(): void {
    if (this.timer) return
    this.startedAt = this.now()
    this.firstTick = true
    this.tick()
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? DEFAULT_TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Public so tests drive the scheduler directly instead of through fake timers.
   *
   * When called without `start()` ever running (as most tests do), `startedAt` is null, so the
   * start instant is resolved as "now" — the boundary in that case collapses to due < now, which
   * a due-and-past fire satisfies unless it is due at exactly this instant. That is deliberate,
   * not incidental: a caller that never started the scheduler has no notion of "while the app was
   * running" to compare against, so a fire it observes strictly in the past is, by definition,
   * one the app was not up for; a fire due at this very instant is still `scheduled`, same as
   * `start()`'s own boundary.
   */
  tick(): void {
    const now = this.now()
    const startedAt = this.startedAt ?? now
    const first = this.firstTick
    this.firstTick = false

    for (const routine of this.deps.store.list()) {
      try {
        const dueIso = this.deps.service.nextRunAt(routine)
        if (!dueIso) continue
        const due = new Date(dueIso)
        if (due.getTime() > now.getTime()) continue
        // A fire the app was CLOSED for: due before this scheduler came up, and seen on the
        // very first tick. Anything later is a fire we were present for, however late.
        const trigger: RoutineTrigger =
          first && due.getTime() < startedAt.getTime() ? 'catchup' : 'scheduled'
        this.deps.service.enqueue(routine, trigger)
      } catch (err) {
        // A routine whose schedule got past the schema makes `nextRunAt` throw. Nothing
        // produces one today — the store parses routines.json as one document, so a bad entry
        // reverts the whole file to defaults — but letting a throw escape would silence every
        // OTHER routine's schedule for the session, and an unattended feature failing silently
        // is the one outcome worth structural effort against.
        console.error(`[routines] scheduling ${routine.id} failed:`, err)
      }
    }
  }
}
