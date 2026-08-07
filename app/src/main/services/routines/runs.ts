import type { DatabaseSync } from 'node:sqlite'
import type { RoutineRunSummary } from '../../../shared/routines'

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
  now: () => Date = defaultNow
): number {
  const res = db
    .prepare(
      `INSERT INTO routine_runs (routine_id, case_slug, status, started_at) VALUES (?, ?, 'running', ?)`
    )
    .run(routineId, caseSlug, now().toISOString())
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
    status: r.status as RoutineRunSummary['status'],
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    summary: r.summary,
    error: r.error
  }))
}
