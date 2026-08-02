import { execFileSync } from 'node:child_process'
import { statusFromGh } from '../seed/prs.mjs'

const OWNER = 'JiaweiHan88'
const REPO = 'HiveMindTest'

/**
 * Bind each repo-backed case to its real pull request and cache the real status.
 *
 * Only REAL pull requests are bound, and no status is fabricated. `usePrStatuses` calls
 * `refresh()` unconditionally on dashboard mount and `refreshPrStatuses` is the only writer of
 * pr_status_cache, so any invented row is overwritten within a second of boot — a fabricated
 * status cannot survive long enough to be photographed. The cached rows written here exist only
 * so the dashboard's first paint is already correct rather than briefly empty.
 *
 * `detected_at` is an explicit timeline point, not `now`: it competes against every other signal
 * in derivePhase, and stamping it with wall-clock time would make every case read 'pr-created'.
 */
export function seedPrs(ctx, { caseIds, repoDir }) {
  const bind = ctx.db.prepare(
    `INSERT INTO pr_bindings (case_id, repo_path, owner, repo, number, url, source, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`
  )
  const cache = ctx.db.prepare(
    `INSERT INTO pr_status_cache (case_id, fetched_at, status_json) VALUES (?, ?, ?)`
  )
  const fetchedAt = ctx.at(ctx.T.REVIEW)
  const summary = {}

  for (const slug of ctx.REPO_SLUGS) {
    const caseId = caseIds[slug]
    const number = ctx.PR_NUMBERS[slug]
    ctx.db.prepare('DELETE FROM pr_bindings WHERE case_id = ?').run(caseId)
    ctx.db.prepare('DELETE FROM pr_status_cache WHERE case_id = ?').run(caseId)

    const raw = JSON.parse(
      execFileSync(
        'gh',
        [
          'pr',
          'view',
          String(number),
          '--json',
          'number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup'
        ],
        { cwd: repoDir, encoding: 'utf8' }
      )
    )
    const status = statusFromGh(raw, { owner: OWNER, repo: REPO, number, now: fetchedAt })

    // HMT-4-nochecks is the 'pr-created' demonstrator: its binding must be the newest signal on
    // that case, so it is stamped later than its session's turns. Every other case's binding is
    // stamped before its review work, so review wins.
    const detectedAt =
      slug === 'HMT-4-nochecks' ? ctx.at(ctx.T.PR_LINKED - 12) : ctx.at(ctx.T.PR_LINKED)

    bind.run(caseId, repoDir, OWNER, REPO, number, status.url, detectedAt)
    cache.run(caseId, fetchedAt, JSON.stringify(status))
    summary[slug] = { number, rollup: status.rollup }
  }
  return summary
}
