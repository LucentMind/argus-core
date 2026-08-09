import type { DatabaseSync } from 'node:sqlite'

/**
 * Where a `jira-jql` routine's next query starts (`routine_cursors`, see db.ts).
 *
 * WHY PERSISTED, and not a field on the service: the same reasoning as anchors.ts. A cursor held
 * in memory is re-derived at every launch, which means either replaying every item the routine
 * already processed or — if the fallback were "now" — skipping everything that arrived while the
 * app was closed. Both are silent.
 *
 * WHY ITS OWN MODULE, and not part of runs.ts: runs.ts is the append-only audit trail, one row
 * per invocation. These are per-routine lifecycle rows with a destructive counterpart
 * (`forgetRoutineCursor`) that the audit trail must never grow. Same split, same reason, as
 * anchors.ts. Electron-free like the rest of services/routines/.
 *
 * Only `jira-jql` writes here. A `cases` scope needs no cursor — see items.ts.
 */

const defaultNow = (): Date => new Date()

/** The last attempted item's cursor value, or null if this routine has never processed one. */
export function readRoutineCursor(db: DatabaseSync, routineId: string): string | null {
  const row = db
    .prepare(`SELECT cursor FROM routine_cursors WHERE routine_id = ?`)
    .get(routineId) as { cursor: string } | undefined
  return row?.cursor ?? null
}

/**
 * Moves the cursor. UPSERT rather than insert-or-ignore — unlike an anchor, which is fixed once
 * and read forever, a cursor's whole job is to move.
 *
 * Called PER ITEM, immediately after that item is attempted, never once at the end of a run: a
 * run capped at 10 of 40 matches must resume at item 11, and a crash at item 7 must not replay
 * items 1-6 as duplicate work on the next launch.
 *
 * REFUSES A BLANK VALUE, LOUDLY. `readRoutineCursor` returns whatever is stored, and every
 * consumer tests it for truthiness (`cursor ? bounded : unbounded`, jiraScopeResolver.ts) — so
 * storing `''` does not mean "no cursor yet", it silently means "start from the beginning of the
 * project again", where every result is already attempted and the routine stalls at zero items
 * per run while every run still reports `ok`. A Jira issue whose `fields` block is missing
 * produces exactly that empty value (the Jira REST client — NAMED INDIRECTLY ON PURPOSE: this
 * directory is verified electron-free and client-free by a plain `grep -rn` over the whole
 * folder, which cannot tell a prose mention from an import), and the resolver already drops such
 * issues
 * before they can be attempted; this throw is the second, independent gate, so a resolver that
 * loses that filter fails its run visibly instead of resetting the routine. Deliberately a throw
 * and not a silent skip: the caller (service.ts's item loop) writes the cursor OUTSIDE the
 * per-item catch, so this fails the whole run with a recorded error — which is the correct,
 * inspectable outcome for state nobody can reconstruct afterwards.
 */
export function writeRoutineCursor(
  db: DatabaseSync,
  routineId: string,
  cursor: string,
  now: () => Date = defaultNow
): void {
  if (!cursor.trim()) {
    throw new Error(
      `Refusing to write an empty cursor for routine ${routineId}: an empty cursor reads back ` +
        `as "never ran", which would restart the scope from the beginning and stall the routine.`
    )
  }
  db.prepare(
    `INSERT INTO routine_cursors (routine_id, cursor, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(routine_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`
  ).run(routineId, cursor, now().toISOString())
}

/**
 * Drops a routine's cursor when its definition is deleted.
 *
 * Ids derive from names, so delete-then-recreate routinely lands on the same id. A surviving
 * cursor would make the recreated routine skip everything the old one had already seen — the
 * mirror of the anchor defect forgetRoutineAnchor exists to prevent.
 */
export function forgetRoutineCursor(db: DatabaseSync, routineId: string): void {
  db.prepare(`DELETE FROM routine_cursors WHERE routine_id = ?`).run(routineId)
}
