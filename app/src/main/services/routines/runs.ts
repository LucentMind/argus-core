import type { DatabaseSync } from 'node:sqlite'
import type { RoutineRunSummary, RoutineTrigger } from '../../../shared/routines'
import { reconcileInterruptedRunItems } from './runItems'

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
  // Null for a scoped run: it opens no `routine-<id>` case, so there is nothing true to record
  // here (service.ts). Per-item cases live on routine_run_items instead.
  caseSlug: string | null,
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
 * Closes out runs AND their in-flight items, stranded by a process that died mid-run.
 *
 * RoutinesService guarantees no run — and, per item, no `routine_run_items` row — is left
 * `running`, but only within one process lifetime. A crash or a quit mid-run leaves the run row
 * `status='running'`, `finished_at=NULL` forever, and `listRoutineRuns` hands it to the UI as a
 * routine that has been executing since last week; a crash mid-TURN leaves that item's own row
 * in the same state, and `payload().runItems` hands it to the UI the same way, forever. This
 * turns both into ordinary `failed` rows that say why — the item reconciliation runs inside this
 * same function (delegated to runItems.ts, which owns that table's SQL) so a stranded item can
 * never outlive its parent run's reconciliation.
 *
 * SAFE ONLY AT STARTUP, AND THAT IS THE WHOLE CONTRACT. The predicate on both tables is
 * `status='running'`, which cannot distinguish a row abandoned by a dead process from one a live
 * run (or a live item within it) is about to finish — so calling this while a run is in flight
 * would mark a perfectly healthy run (or item) failed and then have `finishRoutineRun` /
 * `finishRunItem` overwrite it, corrupting real data. The single call site (index.ts, inside
 * registerIpc) is what makes it safe: it runs before any `ipcMain` handler exists, so before
 * `routinesRunNow` — the only door into `startRun` — can be reached, and runs are serial anyway.
 * A host that is not index.ts (a future headless server) must call this the same way: once, at
 * boot, before it accepts its first run request. Do NOT move it into RoutinesService's
 * constructor: a service can be constructed at any moment, which would make "no run is in flight
 * yet" an assumption instead of a fact.
 *
 * Idempotent: a second call matches no rows on either table, because the first left none
 * `running`.
 *
 * @returns how many stranded RUN rows were reconciled (0 on a clean previous shutdown). Item
 * rows are reconciled as a side effect but not counted here — `strandedRuns` is what index.ts's
 * boot log reports, and a run can strand with zero, one, or many items still `running`.
 */
export function reconcileInterruptedRuns(db: DatabaseSync, now: () => Date = defaultNow): number {
  const finishedAt = now().toISOString()
  const res = db
    .prepare(
      `UPDATE routine_runs SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'`
    )
    .run(finishedAt, INTERRUPTED_RUN_ERROR)
  reconcileInterruptedRunItems(db, finishedAt, INTERRUPTED_RUN_ERROR)
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

/**
 * The inbox predicate, written once.
 *
 * A run still `running` is not a result: it has produced no summary, and showing it as
 * something to review would put a row in the inbox that cannot be acted on. Reviewed-ness and
 * the count and "mark all" all read this same string, so the three can never disagree about
 * what is in the inbox.
 */
const UNREVIEWED = `status != 'running' AND reviewed_at IS NULL`

/**
 * How many of a run's items are still DRAFTS NOBODY HAS ACTED ON, as a correlated subquery.
 *
 * Written once and used by both mark verbs below, exactly like `UNREVIEWED` above, because the
 * two must never disagree about what "still needs review" means — a single-run refusal that
 * "Mark all reviewed" walks straight past would be worse than no rule at all.
 *
 * WHY THIS RULE EXISTS: the Home inbox is the ONLY accept/dismiss surface in the product, and it
 * renders a run only while `${UNREVIEWED}` holds. Marking a run reviewed therefore does not just
 * tidy a list — it removes the only place its draft items can ever be acted on. Those cases keep
 * `review_state = 'draft'` forever: a permanent Draft badge, a suggestion that can never be
 * applied, and permanent exclusion from every `cases`-scoped routine (routines/scopeResolver.ts
 * treats a draft as output, not a candidate). `reviewed_at` lives on the RUN and nothing about
 * writing it touches the cases, so nothing else can notice.
 *
 * ACTIONED means one of the two verbs has landed on the item's case:
 *  - Accept clears `review_state` (service.ts's acceptItem → setCaseReviewState(null)).
 *  - Dismiss CLOSES the case and deliberately leaves `review_state` set, so a dismissed draft
 *    stays distinguishable from a case that was never one — hence `status != 'closed'` here
 *    rather than a review_state check alone. A case a human closed by hand counts as actioned
 *    for the same reason: it is out of the sweep and out of the user's way.
 * An item with no case at all (`case_slug IS NULL` — ingest failed before a case existed) can
 * never be actioned and must never block, which the JOIN handles by producing no row for it.
 */
const UNACTIONED_DRAFT_ITEMS = `(SELECT COUNT(*) FROM routine_run_items i
     JOIN cases c ON c.slug = i.case_slug
    WHERE i.run_id = routine_runs.id AND c.review_state = 'draft' AND c.status != 'closed')`

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * Clears one run out of the inbox.
 *
 * `AND ${UNREVIEWED}` rather than a bare `WHERE id = ?`, for two reasons. A run can finish
 * between the render that produced the button and the click that lands on it, and a live run
 * must not be pre-reviewed by a click that raced it — putting the guard in the renderer would
 * mean putting it on the losing side of that race. And re-marking an already-reviewed run
 * would silently move its timestamp, which is the one fact the row records.
 *
 * THROWS rather than silently declining when the run still has un-actioned draft items (see
 * `UNACTIONED_DRAFT_ITEMS`): a no-op would leave the row sitting in the inbox with nothing to
 * explain why the click did nothing. The message names the count, and the inbox surfaces it the
 * same way it surfaces every other rejected mutation. The count is read under `${UNREVIEWED}` so
 * a run that is running or already reviewed keeps its existing silent no-op — this rule only
 * governs marks that would otherwise take effect.
 */
export function markRunReviewed(
  db: DatabaseSync,
  runId: number,
  now: () => Date = defaultNow
): void {
  const row = db
    .prepare(
      `SELECT ${UNACTIONED_DRAFT_ITEMS} AS n FROM routine_runs WHERE id = ? AND ${UNREVIEWED}`
    )
    .get(runId) as { n: number } | undefined
  const pending = Number(row?.n ?? 0)
  if (pending > 0) {
    throw new Error(
      `This run still has ${plural(pending, 'draft item')} to accept or dismiss — ` +
        `marking it reviewed would hide them for good.`
    )
  }
  db.prepare(`UPDATE routine_runs SET reviewed_at = ? WHERE id = ? AND ${UNREVIEWED}`).run(
    now().toISOString(),
    runId
  )
}

/**
 * Clears the whole inbox.
 *
 * Operates in SQL over every row, not over the 50 `listRoutineRuns` hands the renderer — an
 * inbox deeper than the payload window must still be emptiable in one click.
 *
 * ALL OR NOTHING when any unreviewed run still has un-actioned drafts: it throws BEFORE writing
 * anything rather than clearing the clean runs and reporting the rest. Marking the clean ones
 * would be a partial success that still has to reject, and a rejection is precisely the path on
 * which main does NOT broadcast `routines:changed` — so the renderer would keep showing rows
 * that had in fact just been cleared, in every window. Refusing outright leaves the inbox
 * exactly as it looks.
 *
 * @returns how many rows were cleared.
 */
export function markAllRunsReviewed(db: DatabaseSync, now: () => Date = defaultNow): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(${UNACTIONED_DRAFT_ITEMS}), 0) AS items
         FROM routine_runs
        WHERE ${UNREVIEWED} AND ${UNACTIONED_DRAFT_ITEMS} > 0`
    )
    .get() as { runs: number; items: number } | undefined
  const items = Number(row?.items ?? 0)
  if (items > 0) {
    throw new Error(
      `${plural(items, 'draft item')} in ${plural(Number(row?.runs ?? 0), 'run')} still ` +
        `need accepting or dismissing — clearing the inbox would hide them for good.`
    )
  }
  const res = db
    .prepare(`UPDATE routine_runs SET reviewed_at = ? WHERE ${UNREVIEWED}`)
    .run(now().toISOString())
  return Number(res.changes)
}

/**
 * How many finished runs are waiting to be reviewed.
 *
 * A real COUNT rather than `listRoutineRuns(db).filter(...).length`: that list is capped at 50,
 * so a derived count would under-report precisely when the backlog is large enough to matter.
 */
export function countUnreviewedRuns(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM routine_runs WHERE ${UNREVIEWED}`).get() as
    { n: number } | undefined
  return Number(row?.n ?? 0)
}

interface Row {
  id: number
  routine_id: string
  case_slug: string | null
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
