import type { DatabaseSync } from 'node:sqlite'
import type { IndexState } from '../../shared/types'

/**
 * The single reader of an evidence row's index lifecycle.
 *
 * `meta.indexState` supersedes the older `meta.indexed` boolean, which despite its
 * name recorded whether a file was *indexable* — a confusing neighbour to a real
 * lifecycle field. Rows written before that change (including imported bundles) still
 * carry only `indexed`, so this maps them: `false` means never indexable ('skipped'),
 * `true` means indexing already ran to completion synchronously ('indexed').
 */
export function readIndexState(meta: Record<string, unknown>): IndexState {
  const explicit = meta.indexState
  if (typeof explicit === 'string') return explicit as IndexState
  if (meta.indexed === true) return 'indexed'
  return 'skipped'
}

export function setIndexState(db: DatabaseSync, evidenceId: number, state: IndexState): void {
  const row = db.prepare(`SELECT meta FROM evidence WHERE id = ?`).get(evidenceId) as
    { meta: string } | undefined
  if (!row) return
  const meta = JSON.parse(row.meta) as Record<string, unknown>
  meta.indexState = state
  delete meta.indexed // never leave both representations on one row
  db.prepare(`UPDATE evidence SET meta = ? WHERE id = ?`).run(JSON.stringify(meta), evidenceId)
}

const PENDING_PREDICATE = `json_extract(e.meta, '$.indexState') IN ('pending', 'indexing')`

export interface IndexSweepRow {
  id: number
  caseSlug: string
  relPath: string
  size: number
  state: IndexState
}

/** Every evidence row whose index never finished — the boot re-enqueue set. */
export function listPendingIndexEvidence(db: DatabaseSync): IndexSweepRow[] {
  return sweepRows(db, PENDING_PREDICATE)
}

/**
 * Every row parked at 'error', for the boot sweep to reconsider.
 *
 * Separate from listPendingIndexEvidence, and deliberately NOT folded into
 * PENDING_PREDICATE: countPendingIndex answers "will this resolve itself if I wait",
 * and an errored row does not. Only the boot sweep wants both sets, and only it can
 * tell the two apart afterwards — a retryable error (the file is back) from a
 * still-hopeless one (the file is still gone). Without this, 'error' is a terminal
 * sink: nothing else transitions a row out of it except updateEvidenceContent and
 * rescanModified, and the latter only fires when the file's sha256 CHANGES, so an
 * unchanged file that errored once is never retried.
 */
export function listErroredIndexEvidence(db: DatabaseSync): IndexSweepRow[] {
  return sweepRows(db, ERROR_PREDICATE)
}

function sweepRows(db: DatabaseSync, predicate: string): IndexSweepRow[] {
  return db
    .prepare(
      `SELECT e.id AS id, c.slug AS caseSlug, e.rel_path AS relPath, e.size AS size,
              json_extract(e.meta, '$.indexState') AS state
       FROM evidence e JOIN cases c ON c.id = e.case_id
       WHERE ${predicate}
       ORDER BY e.id`
    )
    .all() as unknown as IndexSweepRow[]
}

/** How many of a case's files are not yet fully searchable. `null` counts every case. */
export function countPendingIndex(db: DatabaseSync, caseSlug: string | null): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM evidence e JOIN cases c ON c.id = e.case_id
       WHERE ${PENDING_PREDICATE} AND (? IS NULL OR c.slug = ?)`
    )
    .get(caseSlug, caseSlug) as { n: number }
  return Number(row.n)
}

const ERROR_PREDICATE = `json_extract(e.meta, '$.indexState') = 'error'`

/**
 * How many of a case's files permanently failed to index. `null` counts every case.
 *
 * Deliberately a sibling of countPendingIndex, not a widened version of it: 'error' is
 * not "not yet" — re-running the same search will never surface these files, so callers
 * that mean "will this resolve itself if I wait" must keep asking countPendingIndex only,
 * and a caller that wants the permanent-failure signal asks this one explicitly.
 */
export function countFailedIndex(db: DatabaseSync, caseSlug: string | null): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM evidence e JOIN cases c ON c.id = e.case_id
       WHERE ${ERROR_PREDICATE} AND (? IS NULL OR c.slug = ?)`
    )
    .get(caseSlug, caseSlug) as { n: number }
  return Number(row.n)
}
