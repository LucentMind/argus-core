import { execFileSync } from 'node:child_process'

const OWNER = 'JiaweiHan88'
const REPO = 'HiveMindTest'
const CHECK_RUN_PASS = new Set(['SUCCESS', 'NEUTRAL'])
const CHECK_RUN_CANCELLED = new Set(['CANCELLED', 'STALE'])

/** Mirrors src/shared/prStatus.ts. */
export function bucketOfCheckRun(status, conclusion) {
  if (status !== 'COMPLETED') return 'pending'
  if (conclusion === 'SKIPPED') return 'skipped'
  if (conclusion && CHECK_RUN_CANCELLED.has(conclusion)) return 'cancelled'
  if (conclusion && CHECK_RUN_PASS.has(conclusion)) return 'pass'
  return 'fail'
}

/** Mirrors src/shared/prStatus.ts. */
export function rollupOf(checks) {
  if (checks.length === 0) return 'none'
  const anyRequired = checks.some((c) => c.required)
  const gates = (c) => c.required || !anyRequired
  if (checks.some((c) => gates(c) && c.bucket === 'fail')) return 'failing'
  if (checks.some((c) => c.bucket === 'fail' || (gates(c) && c.bucket === 'cancelled'))) {
    return 'unstable'
  }
  if (checks.some((c) => c.bucket === 'pending')) return 'running'
  return 'passing'
}

/** Mirrors actionsJobId() in src/shared/prStatus.ts. */
export function actionsJobId(url) {
  if (!url) return null
  const m = /\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/.exec(url)
  return m ? Number(m[1]) : null
}

/** Mirrors bucketOfStatusContext() in src/shared/prStatus.ts. */
export function bucketOfStatusContext(state) {
  if (state === 'SUCCESS') return 'pass'
  if (state === 'FAILURE' || state === 'ERROR') return 'fail'
  return 'pending'
}

/**
 * Pull request 999 does not exist on HiveMindTest. Earlier this function fabricated an
 * elaborate five-bucket check list with an `unstable` rollup for it, but that row is dead on
 * arrival: `usePrStatuses` calls `refresh()` unconditionally on dashboard mount,
 * `refreshPrStatuses` is the only writer of `pr_status_cache`, and pull request 999 does not
 * exist — so within a second of boot the real refresh overwrites this row with an
 * `unavailable` status before anyone can see the fabricated one. That is a property of the
 * app (bindings are always refreshed on mount), not a bug in the fixture, so the seed now
 * writes the SAME shape the app's own `unavailable()` (src/main/services/github.ts) would
 * write, and the case is repurposed as the `unavailable` rollup demonstrator instead of a
 * dead five-bucket fixture.
 */
export function buildSyntheticStatus({ now }) {
  const base = 'https://github.com/JiaweiHan88/HiveMindTest'
  return {
    owner: OWNER,
    repo: REPO,
    number: 999,
    url: `${base}/pull/999`,
    state: 'UNKNOWN',
    isDraft: false,
    mergeable: 'UNKNOWN',
    mergeStateStatus: 'UNKNOWN',
    reviewDecision: null,
    rollup: 'unavailable',
    checks: [],
    fetchedAt: now,
    error: 'No data returned for this pull request.'
  }
}

/** Project one `gh pr view --json` payload into a PrStatus. Mirrors checksOf() in github.ts. */
export function statusFromGh(raw, { owner, repo, number, now }) {
  const checks = (raw.statusCheckRollup ?? []).map((c) => {
    const url = c.detailsUrl ?? c.targetUrl ?? null
    const isStatusContext = c.__typename === 'StatusContext'
    const bucket = isStatusContext
      ? bucketOfStatusContext(c.state ?? null)
      : bucketOfCheckRun(c.status ?? null, c.conclusion ?? null)
    // gh does not report per-pull-request branch protection, and HiveMindTest has
    // none, so every live check is correctly not required.
    return {
      name: isStatusContext ? (c.context ?? '(unnamed status)') : (c.name ?? '(unnamed check)'),
      bucket,
      required: false,
      url,
      // github.ts hard-nulls jobId for StatusContext entries regardless of URL shape —
      // only CheckRun entries (Actions jobs) can ever resolve to a job id.
      jobId: isStatusContext ? null : actionsJobId(url)
    }
  })
  return {
    owner,
    repo,
    number,
    url: raw.url ?? `https://github.com/${owner}/${repo}/pull/${number}`,
    state: raw.state ?? 'UNKNOWN',
    isDraft: Boolean(raw.isDraft),
    mergeable: raw.mergeable ?? 'UNKNOWN',
    mergeStateStatus: raw.mergeStateStatus ?? 'UNKNOWN',
    reviewDecision: raw.reviewDecision ? raw.reviewDecision : null,
    rollup: rollupOf(checks),
    checks,
    fetchedAt: now,
    error: null
  }
}

function ghPrView(number, repoDir) {
  const out = execFileSync(
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
  return JSON.parse(out)
}

/**
 * Write one binding and one cached status per case. The unique index
 * pr_bindings_one_per_case makes a second binding on a case a hard error, so the
 * delete below is not optional tidiness.
 */
export function seedPrs(ctx, { caseIds, repoDir }) {
  const now = ctx.nowIso()
  const bind = ctx.db.prepare(
    `INSERT INTO pr_bindings (case_id, repo_path, owner, repo, number, url, source, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`
  )
  const cache = ctx.db.prepare(
    `INSERT INTO pr_status_cache (case_id, fetched_at, status_json) VALUES (?, ?, ?)`
  )
  const summary = {}
  for (const slug of ctx.SLUGS) {
    const caseId = caseIds[slug]
    const number = ctx.PR_NUMBERS[slug]
    ctx.db.prepare('DELETE FROM pr_bindings WHERE case_id = ?').run(caseId)
    ctx.db.prepare('DELETE FROM pr_status_cache WHERE case_id = ?').run(caseId)
    const status =
      slug === 'SYN-5-edge'
        ? buildSyntheticStatus({ now })
        : statusFromGh(ghPrView(number, repoDir), { owner: OWNER, repo: REPO, number, now })
    const repoPath = slug === 'SYN-5-edge' ? ctx.repoDir('synthetic-widget') : repoDir
    bind.run(caseId, repoPath, OWNER, REPO, number, status.url, now)
    cache.run(caseId, now, JSON.stringify(status))
    summary[slug] = { number, rollup: status.rollup }
  }
  return summary
}
