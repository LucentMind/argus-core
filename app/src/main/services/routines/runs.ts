import type { DatabaseSync } from 'node:sqlite'
import type { RoutineRunSummary, RoutineTrigger } from '../../../shared/routines'

/**
 * DB accessors for the routine-run audit trail (`routine_runs` table, see db.ts). One row per
 * invocation: insertRoutineRun opens it, attachRunSession binds the chat session once it
 * exists, finishRoutineRun closes it out. No network, no orchestration — the routines engine
 * (a later task) owns calling these in order. reconcileInterruptedRuns is the exception: it
 * belongs to the host's startup, not to any run.
 */

const defaultNow = (): Date => new Date()

export function insertRoutineRun(
  db: DatabaseSync,
  routineId: string,
  caseSlug: string,
  trigger: RoutineTrigger,
  now: () => Date = defaultNow
): number {
  const res = db
    .prepare(
      `INSERT INTO routine_runs (routine_id, case_slug, status, started_at, trigger_kind)
       VALUES (?, ?, 'running', ?, ?)`
    )
    .run(routineId, caseSlug, now().toISOString(), trigger)
  return Number(res.lastInsertRowid)
}

export function attachRunSession(db: DatabaseSync, runId: number, sessionId: number): void {
  db.prepare(`UPDATE routine_runs SET session_id = ? WHERE id = ?`).run(sessionId, runId)
}

/** The `error` text a reconciled run carries. Exported so tests assert the real string. */
export const INTERRUPTED_RUN_ERROR =
  'Interrupted: the app exited or crashed while this run was in progress.'

/**
 * Closes out runs stranded by a process that died mid-run.
 *
 * RoutinesService guarantees no run is left `running` — but only within one process lifetime.
 * A crash or a quit mid-run leaves the row `status='running'`, `finished_at=NULL` forever, and
 * `listRoutineRuns` hands it to the UI as a routine that has been executing since last week.
 * This turns those rows into ordinary `failed` runs that say why.
 *
 * SAFE ONLY AT STARTUP, AND THAT IS THE WHOLE CONTRACT. The predicate is `status='running'`,
 * which cannot distinguish a row abandoned by a dead process from one a live run is about to
 * finish — so calling this while a run is in flight would mark a perfectly healthy run failed
 * and then have `finishRoutineRun` overwrite it, corrupting real data. The single call site
 * (index.ts, inside registerIpc) is what makes it safe: it runs before any `ipcMain` handler
 * exists, so before `routinesRunNow` — the only door into `startRun` — can be reached, and runs
 * are serial anyway. A host that is not index.ts (a future headless server) must call this the
 * same way: once, at boot, before it accepts its first run request. Do NOT move it into
 * RoutinesService's constructor: a service can be constructed at any moment, which would make
 * "no run is in flight yet" an assumption instead of a fact.
 *
 * Idempotent: a second call matches no rows, because the first left none `running`.
 *
 * @returns how many stranded rows were reconciled (0 on a clean previous shutdown).
 */
export function reconcileInterruptedRuns(db: DatabaseSync, now: () => Date = defaultNow): number {
  const res = db
    .prepare(
      `UPDATE routine_runs SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'`
    )
    .run(now().toISOString(), INTERRUPTED_RUN_ERROR)
  return Number(res.changes)
}

/**
 * The routine id whose run is CURRENTLY executing in `sessionId`, or null.
 *
 * Exists to keep a second, fully-permissioned session off a routine's own session row. A
 * routine's transcript is deliberately streamed into the normal case UI (index.ts), so the
 * `routine-<id>` case is openable and its session selectable WHILE the run is in flight. A
 * message typed there reaches `AgentService.send`, which finds no map entry for the background
 * session (it never enters that map) and builds a SECOND `CaseSession` on the same `sessionId`:
 * this one without `unattended`, with connectors composed, resuming from the same cursor. Two
 * drivers would then write the same `sessions/<id>.jsonl` mirror and the same `turns` /
 * `tool_calls` rows — and when the routine finished, its `stop()` would emit `session.exited`
 * for that sessionId and tear the user's live chat down under them.
 *
 * Reads the run table rather than asking the service, so it answers correctly from anywhere
 * holding the db — including AgentService, which knows nothing about routines and is handed
 * this as an injected predicate.
 */
export function runningRoutineForSession(db: DatabaseSync, sessionId: number): string | null {
  const row = db
    .prepare(
      `SELECT routine_id FROM routine_runs WHERE session_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId) as { routine_id: string } | undefined
  return row?.routine_id ?? null
}

/**
 * When this routine was last ATTEMPTED, whatever the outcome — the schedule's anchor.
 *
 * Attempts, not successes, and the distinction is load-bearing: anchoring on success would
 * leave a failing routine's anchor unmoved, so it would be due again on the very next tick and
 * retry every 30 seconds, unattended, until someone noticed. See lastSuccessAt for the other
 * half of the pair.
 *
 * MAX() over ISO-8601 UTC text is chronological because `toISOString()` is fixed-width and
 * zero-padded, so lexicographic order and time order coincide. Every writer here goes through
 * `toISOString()`; anything that writes a different format breaks this.
 */
export function lastAttemptAt(db: DatabaseSync, routineId: string): string | null {
  const row = db
    .prepare(`SELECT MAX(started_at) AS t FROM routine_runs WHERE routine_id = ?`)
    .get(routineId) as { t: string | null } | undefined
  return row?.t ?? null
}

/**
 * When this routine last SUCCEEDED — the watermark handed to the next run.
 *
 * Successes only: a failed run advanced nothing, and telling the next run it succeeded then
 * would make it skip work that was never done.
 */
export function lastSuccessAt(db: DatabaseSync, routineId: string): string | null {
  const row = db
    .prepare(
      `SELECT MAX(finished_at) AS t FROM routine_runs WHERE routine_id = ? AND status = 'ok'`
    )
    .get(routineId) as { t: string | null } | undefined
  return row?.t ?? null
}

export function finishRoutineRun(
  db: DatabaseSync,
  runId: number,
  outcome: { status: 'ok' | 'failed' | 'timeout'; summary?: string; error?: string },
  now: () => Date = defaultNow
): void {
  db.prepare(
    `UPDATE routine_runs SET status = ?, finished_at = ?, summary = ?, error = ? WHERE id = ?`
  ).run(outcome.status, now().toISOString(), outcome.summary ?? null, outcome.error ?? null, runId)
}

interface Row {
  id: number
  routine_id: string
  case_slug: string
  session_id: number | null
  status: string
  started_at: string
  finished_at: string | null
  summary: string | null
  error: string | null
  trigger_kind: string
  reviewed_at: string | null
}

export function listRoutineRuns(db: DatabaseSync, limit = 50): RoutineRunSummary[] {
  const rows = db
    .prepare(`SELECT * FROM routine_runs ORDER BY id DESC LIMIT ?`)
    .all(limit) as unknown as Row[]
  return rows.map((r) => ({
    id: r.id,
    routineId: r.routine_id,
    caseSlug: r.case_slug,
    sessionId: r.session_id,
    trigger: r.trigger_kind as RoutineTrigger,
    status: r.status as RoutineRunSummary['status'],
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    summary: r.summary,
    error: r.error,
    reviewedAt: r.reviewed_at ?? null
  }))
}
