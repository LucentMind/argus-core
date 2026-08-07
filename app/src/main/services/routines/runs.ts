import type { DatabaseSync } from 'node:sqlite'
import type { RoutineRunSummary } from '../../../shared/routines'

/**
 * DB accessors for the routine-run audit trail (`routine_runs` table, see db.ts). One row per
 * invocation: insertRoutineRun opens it, attachRunSession binds the chat session once it
 * exists, finishRoutineRun closes it out. No network, no orchestration — the routines engine
 * (a later task) owns calling these in order.
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
