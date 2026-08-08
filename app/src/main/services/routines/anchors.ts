import type { DatabaseSync } from 'node:sqlite'

/**
 * The schedule origin for a routine that has never run (`routine_anchors`, see db.ts).
 *
 * WHY THIS IS PERSISTED, rather than a field on the service. `nextRunAt` anchors on the
 * routine's last attempt; a routine with no attempts needs some other origin, and increment 2
 * originally used service construction time — app boot in production. That is wrong in both
 * directions, and neither failure is visible:
 *  - App open for two days, user saves a `daily 02:00`: the next fire measured from BOOT is
 *    yesterday, i.e. already past, so the scheduler launches an unattended run within one tick
 *    of the routine being saved. Generalised: once uptime exceeds a schedule's period, every
 *    newly created routine on that schedule fires the moment it is saved.
 *  - The mirror image: an `interval` whose period exceeds typical uptime can never fire at all,
 *    because each launch pushes its first fire further out and it never runs, so it never earns
 *    a `routine_runs` anchor to recover from. Silent, permanent.
 * A row on disk fixes the origin once, so the first fire converges on a real instant instead of
 * receding with each launch.
 *
 * Deliberately its own module rather than part of runs.ts: runs.ts is the append-only audit
 * trail, one row per invocation, and these rows are neither — they are per-routine lifecycle
 * state with a destructive counterpart (`forgetRoutineAnchor`) that the run history must never
 * grow. Same electron-free rule as the rest of services/routines/.
 */

const defaultNow = (): Date => new Date()

/**
 * The instant this routine's schedule is measured from, creating it on first sight.
 *
 * IDEMPOTENT BY CONSTRUCTION, and that is the whole design: `INSERT OR IGNORE` means the first
 * call for a routine id fixes its anchor forever and every later call reads the same row back,
 * so callers need no "have I seen this before" bookkeeping and cannot accidentally move it.
 * That also makes it safe on the read path — `payload()` calls it for every scheduled routine.
 */
export function ensureRoutineAnchor(
  db: DatabaseSync,
  routineId: string,
  now: () => Date = defaultNow
): string {
  db.prepare(`INSERT OR IGNORE INTO routine_anchors (routine_id, anchored_at) VALUES (?, ?)`).run(
    routineId,
    now().toISOString()
  )
  const row = db
    .prepare(`SELECT anchored_at FROM routine_anchors WHERE routine_id = ?`)
    .get(routineId) as { anchored_at: string } | undefined
  // The row was just inserted-or-ignored, so it exists; the fallback keeps the return type
  // honest rather than asserting non-null over a query.
  return row?.anchored_at ?? now().toISOString()
}

/**
 * Drops a routine's anchor, so a routine recreated under the same id starts over.
 *
 * Ids are derived from the routine's name, so delete-then-recreate routinely lands on the same
 * id. A surviving anchor from weeks ago would make the recreated routine overdue the instant it
 * was saved — the exact defect ensureRoutineAnchor exists to prevent, re-entering through the
 * store instead of through the clock.
 */
export function forgetRoutineAnchor(db: DatabaseSync, routineId: string): void {
  db.prepare(`DELETE FROM routine_anchors WHERE routine_id = ?`).run(routineId)
}
