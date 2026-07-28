import type { DatabaseSync } from 'node:sqlite'
import type { NewPrBinding, PrBinding } from '../../shared/pr'
import { updateClaudeMdPrs } from './skillsDir'
import { clearPrStatus } from './prStatusCache'

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

/**
 * Bind a pull request to a case, replacing whatever was bound before. A case has at most one
 * PR (see the unique index in db.ts): re-adding the SAME pr is idempotent and keeps the row's
 * identity, while a different one supersedes it.
 */
export function addBinding(db: DatabaseSync, caseSlug: string, input: NewPrBinding): PrBinding {
  const caseId = caseIdOf(db, caseSlug)
  // Delete-then-insert as one statement pair: the unique index would reject the insert if a
  // different PR were still bound, and a partial apply would leave the case with no PR at all.
  db.exec('BEGIN')
  try {
    db.prepare(
      `DELETE FROM pr_bindings
        WHERE case_id = ? AND NOT (owner = ? AND repo = ? AND number = ?)`
    ).run(caseId, input.owner, input.repo, input.number)
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
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  // The cached status describes the PR that WAS bound. Leaving it would show the old PR's
  // checks under the new one until the first refresh lands — and on a replace, a green dot for
  // a PR the user just stopped looking at. Clearing is safe: absent reads as "not fetched yet",
  // which is exactly true.
  //
  // Deliberately OUTSIDE the try: the plan put it inside, immediately after COMMIT, but the
  // catch there runs `ROLLBACK` — and rolling back a transaction that just committed throws its
  // own error, masking whatever actually went wrong. Nothing after a committed write belongs in
  // a block whose handler assumes the write is still open.
  clearPrStatus(db, caseSlug)
  const row = db
    .prepare(
      `SELECT * FROM pr_bindings WHERE case_id = ? AND owner = ? AND repo = ? AND number = ?`
    )
    .get(caseId, input.owner, input.repo, input.number) as unknown as PrBindingRow
  return rowToBinding(row)
}

/** The case's bound pull request, or null. The single-binding read every consumer should use. */
export function getBinding(db: DatabaseSync, caseSlug: string): PrBinding | null {
  const caseId = caseIdOf(db, caseSlug)
  const row = db.prepare(`SELECT * FROM pr_bindings WHERE case_id = ?`).get(caseId) as unknown as
    PrBindingRow | undefined
  return row ? rowToBinding(row) : null
}

/**
 * At most one row (the unique index in db.ts enforces it) — kept for `IPC.prList`
 * (main/index.ts), which the repo chips read as a list so they render correctly whether the
 * case has zero or one PR bound. Every other consumer wants the single binding directly:
 * prefer `getBinding`.
 */
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
  clearPrStatus(db, caseSlug)
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

/** Checks a PR's code out locally; returns its worktree path, or null when it has none. */
export type PrMaterializer = (binding: PrBinding) => Promise<string | null>

/**
 * Check out every bound PR that has a local clone, then tell the agent where each one is.
 *
 * Two callers share this so they cannot drift: entering review mode (for already-bound
 * PRs whose worktree may be absent — fresh clone, another machine, pruned worktree) and
 * confirming the PR picker (for PRs just selected).
 *
 * Checkout is lazy and never fatal: a binding with `repoPath === null` is skipped by
 * design (the agent falls back to `gh pr diff`), and a git failure is logged and stepped
 * over so it can never block a mode switch. The `CLAUDE.md` write is wrapped the same way:
 * by the time this runs, `addBinding` has already committed, so an fs error here (disk
 * full, permissions) must not turn into a rejected `pr:link` call — that used to read to
 * callers as "the link failed" (e.g. the Repos rail's manual-link catch reporting "Not a
 * pull request reference") for a PR that was, in fact, bound. The `getBinding` read itself
 * gets the same treatment for the same reason (a bare SELECT on a connection that just
 * committed is unlikely to fail, but "unlikely" is not "impossible", and this function's
 * whole point is that nothing downstream of a committed write may read as a failure) — on
 * failure it logs and returns without touching `CLAUDE.md` at all, rather than writing an
 * "unbound" state it can't actually confirm.
 */
export async function materializePrBindings(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  materialize: PrMaterializer
): Promise<void> {
  const lines: {
    owner: string
    repo: string
    number: number
    url: string
    worktreePath: string | null
  }[] = []
  let b: PrBinding | null
  try {
    b = getBinding(db, caseSlug)
  } catch (err) {
    console.warn(`[pr] getBinding for ${caseSlug} failed: ${(err as Error).message}`)
    return
  }
  if (b) {
    let worktreePath: string | null = null
    if (b.repoPath) {
      try {
        worktreePath = await materialize(b)
      } catch (err) {
        console.warn(
          `[pr] worktree for ${b.owner}/${b.repo}#${b.number} failed: ${(err as Error).message}`
        )
      }
    }
    lines.push({ owner: b.owner, repo: b.repo, number: b.number, url: b.url, worktreePath })
  }
  try {
    updateClaudeMdPrs(argusHome, caseSlug, lines)
  } catch (err) {
    console.warn(`[pr] CLAUDE.md update for ${caseSlug} failed: ${(err as Error).message}`)
  }
}
