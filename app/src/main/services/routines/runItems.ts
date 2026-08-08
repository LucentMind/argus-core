import type { DatabaseSync } from 'node:sqlite'
import type {
  RoutineRunItemStatus,
  RoutineRunItemSummary,
  TriageSuggestion
} from '../../../shared/routines'

/**
 * DB accessors for the per-item audit trail (`routine_run_items`, see db.ts). One row per item a
 * scoped run touched: `insertRunItem` opens it, `attachItemCase` binds the case once it exists,
 * `saveItemSuggestion` records what the turn proposed, `finishRunItem` closes it.
 *
 * These rows are the reason parent §2's "per-item outcomes" and "per-item errors never kill a
 * run" are facts rather than claims. The alternative — asking the model which items it handled —
 * fails in the direction that looks like success.
 *
 * No network, no orchestration: service.ts owns calling these in order.
 */

const defaultNow = (): Date => new Date()

export function insertRunItem(
  db: DatabaseSync,
  runId: number,
  itemKey: string,
  now: () => Date = defaultNow
): number {
  const res = db
    .prepare(
      `INSERT INTO routine_run_items (run_id, item_key, status, started_at)
       VALUES (?, ?, 'running', ?)`
    )
    .run(runId, itemKey, now().toISOString())
  return Number(res.lastInsertRowid)
}

export function attachItemCase(db: DatabaseSync, itemId: number, caseSlug: string): void {
  db.prepare(`UPDATE routine_run_items SET case_slug = ? WHERE id = ?`).run(caseSlug, itemId)
}

export function finishRunItem(
  db: DatabaseSync,
  itemId: number,
  outcome: { status: Exclude<RoutineRunItemStatus, 'running'>; error?: string },
  now: () => Date = defaultNow
): void {
  db.prepare(`UPDATE routine_run_items SET status = ?, error = ?, finished_at = ? WHERE id = ?`).run(
    outcome.status,
    outcome.error ?? null,
    now().toISOString(),
    itemId
  )
}

export function saveItemSuggestion(
  db: DatabaseSync,
  itemId: number,
  suggestion: TriageSuggestion
): void {
  db.prepare(`UPDATE routine_run_items SET suggestion = ? WHERE id = ?`).run(
    JSON.stringify(suggestion),
    itemId
  )
}

interface Row {
  id: number
  run_id: number
  item_key: string
  case_slug: string | null
  status: string
  error: string | null
  suggestion: string | null
  started_at: string
  finished_at: string | null
}

/**
 * A stored suggestion that will not parse yields `null`, not a throw.
 *
 * The column holds JSON this process wrote, so a bad blob means a hand edit or a partial write —
 * neither of which is worth taking the whole inbox down for. The item's own outcome is still
 * readable, which is the part that matters.
 */
function parseSuggestion(raw: string | null): TriageSuggestion | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as TriageSuggestion
  } catch {
    return null
  }
}

const toSummary = (r: Row): RoutineRunItemSummary => ({
  id: r.id,
  runId: r.run_id,
  itemKey: r.item_key,
  caseSlug: r.case_slug,
  status: r.status as RoutineRunItemStatus,
  error: r.error,
  suggestion: parseSuggestion(r.suggestion),
  startedAt: r.started_at,
  finishedAt: r.finished_at
})

export function getRunItem(db: DatabaseSync, itemId: number): RoutineRunItemSummary | null {
  const row = db.prepare(`SELECT * FROM routine_run_items WHERE id = ?`).get(itemId) as
    | unknown as Row | undefined
  return row ? toSummary(row) : null
}

/**
 * Items for a set of runs, in insertion order.
 *
 * The empty-list guard is not defensive tidiness: `IN ()` is a SQL syntax error, and the payload
 * asks for items on every refresh — including the very common case of an install with no scoped
 * runs at all.
 */
export function listRunItems(db: DatabaseSync, runIds: number[]): RoutineRunItemSummary[] {
  if (runIds.length === 0) return []
  const holes = runIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT * FROM routine_run_items WHERE run_id IN (${holes}) ORDER BY id ASC`)
    .all(...runIds) as unknown as Row[]
  return rows.map(toSummary)
}

/**
 * Every item key this routine has ATTEMPTED, across all of its runs.
 *
 * Attempted, not succeeded — this set is what stops the cursor's inclusive `>=` boundary from
 * re-processing the item it just finished (items.ts). Scoped to one routine: two routines may
 * legitimately both work the same ticket.
 */
export function attemptedItemKeys(db: DatabaseSync, routineId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT i.item_key AS k FROM routine_run_items i
       JOIN routine_runs r ON r.id = i.run_id
       WHERE r.routine_id = ?`
    )
    .all(routineId) as unknown as { k: string }[]
  return new Set(rows.map((r) => r.k))
}

/**
 * The newest item row that produced this case — what accept/dismiss acts on.
 *
 * Newest, because a routine may revisit a case across runs and the suggestion the user is
 * looking at is the most recent one.
 */
export function runItemForCase(db: DatabaseSync, caseSlug: string): RoutineRunItemSummary | null {
  const row = db
    .prepare(`SELECT * FROM routine_run_items WHERE case_slug = ? ORDER BY id DESC LIMIT 1`)
    .get(caseSlug) as unknown as Row | undefined
  return row ? toSummary(row) : null
}
