import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { RecentRepo } from '../../shared/types'

/** Distinct cases a repo must be linked to before Argus offers to make it a default. */
export const PROMOTE_THRESHOLD = 3

/** How many recents the dropdown offers. */
const RECENT_LIMIT = 10

/**
 * Canonical key for a repo path — the same normalization `withRepoLock` keys on, so a
 * trailing separator cannot split one repo into two rows. Case is deliberately NOT folded:
 * both the native dialog and the dropdown emit the OS's own casing, so a case difference
 * would require picking the same repo through two routes that disagree, which the dialog
 * does not produce.
 */
export function repoKey(repoPath: string): string {
  return path.resolve(repoPath)
}

/** IPC-boundary guard: these handlers take a bare path from the renderer. */
export function assertRepoPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || p.trim() === '')
    throw new Error(`Invalid repo path: ${JSON.stringify(p)}`)
}

/**
 * Record that `repoPath` was linked to `caseSlug`. One row per (repo, case) PAIR, not per
 * link event: relinking inside a single case refreshes the timestamp without inflating the
 * count, which is what makes "you have linked this to N cases" literally true.
 */
export function recordLink(
  db: DatabaseSync,
  repoPath: string,
  caseSlug: string,
  now: () => Date = () => new Date()
): void {
  db.prepare(
    `INSERT OR REPLACE INTO repo_usage (path, case_slug, linked_at) VALUES (?, ?, ?)`
  ).run(repoKey(repoPath), caseSlug, now().toISOString())
}

/** Distinct cases this repo has been manually linked to. Never decremented on unlink —
 *  this is a usage record, not a live relationship. `listWorkspaces` remains the only
 *  source of truth for what is currently linked. */
export function caseCount(db: DatabaseSync, repoPath: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM repo_usage WHERE path = ?`)
    .get(repoKey(repoPath)) as { n: number | bigint }
  return Number(row.n)
}

/**
 * How many rows beyond `limit` to pull from SQL, as a multiple of `limit`, before applying
 * the existence filter. The contract is "the `limit` most recent REACHABLE repos" — an
 * unreachable repo must yield its slot to the next reachable one, not shrink the list — so
 * filtering cannot happen after a `LIMIT limit` (that only ever removes rows). This bounds
 * both directions: it caps `fs.existsSync` calls at `limit * OVERFETCH_MULTIPLIER` (each row
 * costs one stat, so fetching every row ever recorded is not acceptable either), while
 * tolerating up to `(OVERFETCH_MULTIPLIER - 1) * limit` unreachable rows among the most
 * recent candidates before the result can still fall short of `limit` despite enough older
 * reachable repos existing — far more slack than a single disconnected drive needs.
 */
const OVERFETCH_MULTIPLIER = 4

/**
 * Most-recently-linked repos, newest first. Paths that no longer exist are FILTERED rather
 * than deleted: a repo on a disconnected network drive reappears when the drive returns
 * instead of being silently forgotten. `exists` is injected so tests need no real files.
 */
export function listRecent(
  db: DatabaseSync,
  limit: number = RECENT_LIMIT,
  exists: (p: string) => boolean = fs.existsSync
): RecentRepo[] {
  const rows = db
    .prepare(
      `SELECT path, MAX(linked_at) AS last FROM repo_usage
       GROUP BY path ORDER BY last DESC LIMIT ?`
    )
    .all(limit * OVERFETCH_MULTIPLIER) as { path: string; last: string }[]
  return rows
    .filter((r) => exists(r.path))
    .slice(0, limit)
    .map((r) => ({ path: r.path, name: path.basename(r.path) }))
}

export function isPromoteDismissed(db: DatabaseSync, repoPath: string): boolean {
  const row = db
    .prepare(`SELECT promote_dismissed AS d FROM repo_prefs WHERE path = ?`)
    .get(repoKey(repoPath)) as { d: number | bigint } | undefined
  return row !== undefined && Number(row.d) === 1
}

/** Permanent: one "Not now" silences the prompt for this repo forever. Settings stays
 *  available as the manual path to make it a default later. */
export function dismissPromote(db: DatabaseSync, repoPath: string): void {
  db.prepare(
    `INSERT INTO repo_prefs (path, promote_dismissed) VALUES (?, 1)
     ON CONFLICT(path) DO UPDATE SET promote_dismissed = 1`
  ).run(repoKey(repoPath))
}

/**
 * Whether the renderer should raise the promote-to-default prompt after this link.
 * Lives here rather than in the IPC handler so the decision is unit-testable without
 * booting Electron — the same "handler body lives in a service, thin wrapper in index.ts"
 * split the `pr:*` handlers use.
 */
export function shouldSuggestDefault(
  db: DatabaseSync,
  repoPath: string,
  defaultRepos: readonly string[]
): boolean {
  const key = repoKey(repoPath)
  if (defaultRepos.some((d) => repoKey(d) === key)) return false
  if (isPromoteDismissed(db, repoPath)) return false
  return caseCount(db, repoPath) >= PROMOTE_THRESHOLD
}
