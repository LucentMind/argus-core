/**
 * The shape a bound pull request's status takes once it has left `gh` and before it reaches any
 * UI. Pure and shared: main fetches and caches it, the renderer renders it, and neither owns the
 * vocabulary. (`src/shared` may not import from `src/main` — see the layering rule.)
 */

export type CheckBucket = 'pass' | 'fail' | 'cancelled' | 'pending' | 'skipped'

/** `unavailable` is not a CI state: it means we could not read this PR at all (deleted, access
 *  lost, network). It exists so a case never sits on a stale green dot. */
export type PrRollup = 'passing' | 'failing' | 'running' | 'none' | 'unavailable'

export interface PrCheck {
  name: string
  bucket: CheckBucket
  /** The check's own page. Null for a context that reported none. */
  url: string | null
  /** The GitHub Actions job id, when this check is an Actions job. Null for every third-party
   *  check — and null is exactly what makes its log unfetchable (see `actionsJobId`). */
  jobId: number | null
}

export interface PrStatus {
  owner: string
  repo: string
  number: number
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED' | 'UNKNOWN'
  isDraft: boolean
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  rollup: PrRollup
  checks: PrCheck[]
  /** ISO timestamp of the fetch that produced this, so the UI can say how stale it is. */
  fetchedAt: string
  /** Set only when `rollup === 'unavailable'`; the GraphQL error text for THIS target. */
  error: string | null
}

/**
 * An Actions job id out of a check's details url, or null.
 *
 * This one function is the whole "which checks can we read logs for" rule (design decision 8):
 * only `…/actions/runs/<runId>/job/<jobId>` yields an id, so a CircleCI or Buildkite context —
 * and an Actions *run* url with no job segment — returns null and its Analyze button is disabled.
 *
 * The real capture (see `__tests__/fixtures/README.md`) proves this is not merely a third-party
 * concern: Netlify posts `CheckRun` nodes with an `app.netlify.com` details url, and CodeQL posts
 * `https://github.com/<owner>/<repo>/runs/<id>` — a github.com url with no job segment. Both are
 * correctly unfetchable.
 */
export function actionsJobId(url: string | null): number | null {
  if (!url) return null
  const m = /\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/.exec(url)
  return m ? Number(m[1]) : null
}

const CHECK_RUN_PASS = new Set(['SUCCESS', 'NEUTRAL'])

/**
 * Runs GitHub threw away rather than verdicts it reached: `CANCELLED` is a concurrency group,
 * a re-push or a sibling job dying; `STALE` is a run GitHub itself discarded. Collapsing them
 * into `fail` made a single broken job render as three red rows — see the capture in
 * `main/services/__tests__/fixtures/prStatus.cancelled.json` — and handed two of them an
 * Analyze button whose log contains only the cancellation.
 */
const CHECK_RUN_CANCELLED = new Set(['CANCELLED', 'STALE'])

export function bucketOfCheckRun(status: string | null, conclusion: string | null): CheckBucket {
  // Anything GitHub has not marked COMPLETED is still running, whatever its conclusion says.
  if (status !== 'COMPLETED') return 'pending'
  if (conclusion === 'SKIPPED') return 'skipped'
  if (conclusion && CHECK_RUN_CANCELLED.has(conclusion)) return 'cancelled'
  if (conclusion && CHECK_RUN_PASS.has(conclusion)) return 'pass'
  // Deliberately NOT a default of 'pass': a conclusion we do not recognize (a new GitHub value,
  // a completed run with a null conclusion) must show as needing attention, never as green.
  return 'fail'
}

export function bucketOfStatusContext(state: string | null): CheckBucket {
  if (state === 'SUCCESS') return 'pass'
  if (state === 'FAILURE' || state === 'ERROR') return 'fail'
  return 'pending'
}

/**
 * A failure outranks a pending check: with one job red and three still running, the actionable
 * fact is the red one, and waiting for the rest to finish before saying so helps nobody.
 */
export function rollupOf(checks: PrCheck[]): PrRollup {
  if (checks.length === 0) return 'none'
  if (checks.some((c) => c.bucket === 'fail')) return 'failing'
  if (checks.some((c) => c.bucket === 'pending')) return 'running'
  return 'passing'
}
