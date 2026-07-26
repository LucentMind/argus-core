import type { DatabaseSync } from 'node:sqlite'
import type { NewPrBinding, PrBinding } from '../../shared/pr'

// A raw id lookup rather than caseService's getCase: this module only needs the numeric
// id, and importing getCase would recreate a module cycle that was deliberately removed
// (same reasoning as agent/sessionStore.ts's caseIdOf).
function caseIdOf(db: DatabaseSync, caseSlug: string): number {
  const row = db.prepare(`SELECT id FROM cases WHERE slug = ?`).get(caseSlug) as
    { id: number } | undefined
  if (!row) throw new Error(`Unknown case: ${caseSlug}`)
  return row.id
}

interface PrBindingRow {
  id: number
  case_id: number
  repo_path: string | null
  owner: string
  repo: string
  number: number
  url: string
  source: string
  detected_at: string
}

function rowToBinding(row: PrBindingRow): PrBinding {
  return {
    id: row.id,
    caseId: row.case_id,
    repoPath: row.repo_path,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    url: row.url,
    source: row.source as PrBinding['source'],
    detectedAt: row.detected_at
  }
}

/** Idempotent on (case, owner, repo, number): re-adding returns the existing row. */
export function addBinding(db: DatabaseSync, caseSlug: string, input: NewPrBinding): PrBinding {
  const caseId = caseIdOf(db, caseSlug)
  db.prepare(
    `INSERT INTO pr_bindings (case_id, repo_path, owner, repo, number, url, source, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(case_id, owner, repo, number) DO NOTHING`
  ).run(
    caseId,
    input.repoPath,
    input.owner,
    input.repo,
    input.number,
    input.url,
    input.source,
    new Date().toISOString()
  )
  const row = db
    .prepare(
      `SELECT * FROM pr_bindings WHERE case_id = ? AND owner = ? AND repo = ? AND number = ?`
    )
    .get(caseId, input.owner, input.repo, input.number) as unknown as PrBindingRow
  return rowToBinding(row)
}

/** Newest first. */
export function listBindings(db: DatabaseSync, caseSlug: string): PrBinding[] {
  const caseId = caseIdOf(db, caseSlug)
  const rows = db
    .prepare(`SELECT * FROM pr_bindings WHERE case_id = ? ORDER BY id DESC`)
    .all(caseId) as unknown as PrBindingRow[]
  return rows.map(rowToBinding)
}

export function removeBinding(db: DatabaseSync, caseSlug: string, bindingId: number): void {
  const caseId = caseIdOf(db, caseSlug)
  db.prepare(`DELETE FROM pr_bindings WHERE case_id = ? AND id = ?`).run(caseId, bindingId)
}

/**
 * Bindings on a case. This does NOT gate review-mode availability (linked repos do) —
 * it only answers "is the PR picker due?". See modeContext.ts.
 */
export function bindingCount(db: DatabaseSync, caseSlug: string): number {
  const caseId = caseIdOf(db, caseSlug)
  const row = db.prepare(`SELECT COUNT(*) AS n FROM pr_bindings WHERE case_id = ?`).get(caseId) as
    { n: number } | undefined
  return row?.n ?? 0
}
