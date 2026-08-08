import type { DatabaseSync } from 'node:sqlite'
import type { RoutineScope } from '../../../shared/routines'
import type { CaseCandidate, ResolvedItem } from './items'

/**
 * How a scope becomes items.
 *
 * SPLIT IN TWO ON PURPOSE. The `cases` half is local SQL and lives here. The `jira-jql` half
 * needs the Atlassian client, which services/routines/ must not import — so it arrives as an
 * INJECTED `ScopeResolver`, bound in main/index.ts alongside notify/onEvent/broadcast. Same rule
 * as the electron ban, one level out.
 *
 * THE INTERFACE IS THE TRUST BOUNDARY. Scope resolution is the first thing Argus does that
 * reaches an external system with the user's credentials while no human is present. Parent §4
 * permits it because routines are read-only against external systems — and here that is
 * structural rather than remembered: there is no method on this interface that writes to Jira.
 */
export interface ScopeResolver {
  /**
   * Items matching `jql` at or after `cursor`, oldest first.
   *
   * The boundary is INCLUSIVE (`>=`): Jira timestamps are not unique, and a strict `>` would
   * drop one of two tickets sharing a minute, permanently and silently. items.ts removes the
   * duplicate by key.
   */
  resolveJql(
    jql: string,
    cursorField: 'created' | 'updated',
    cursor: string | null,
    limit: number
  ): Promise<ResolvedItem[]>

  /** Fetches the ticket into a case (creating or adopting) and returns its slug. */
  ingestJiraItem(key: string): Promise<{ caseSlug: string }>
}

const defaultNow = (): Date => new Date()

interface Row {
  slug: string
  updated_at: string
  last_attempt_at: string | null
}

/**
 * Cases a `cases`-scoped routine could look at, each with THIS routine's last look at it.
 *
 * The last-look join is scoped to `routineId`. Leaking another routine's newer look would make
 * this routine skip a case it has never seen — a silent hole that grows with every routine added.
 *
 * Draft cases are excluded here rather than in items.ts, because a draft is not a candidate at
 * all: it is output this routine already produced and a human has not acted on.
 */
export function resolveCaseCandidates(
  db: DatabaseSync,
  routineId: string,
  scope: Extract<RoutineScope, { kind: 'cases' }>,
  now: () => Date = defaultNow
): CaseCandidate[] {
  const where: string[] = [`c.review_state IS NULL`]
  const args: (string | number)[] = [routineId]

  if (scope.status?.length) {
    where.push(`c.status IN (${scope.status.map(() => '?').join(',')})`)
    args.push(...scope.status)
  }
  if (scope.untouchedForDays !== undefined) {
    const cutoff = new Date(now().getTime() - scope.untouchedForDays * 86_400_000).toISOString()
    where.push(`c.updated_at < ?`)
    args.push(cutoff)
  }

  const rows = db
    .prepare(
      `SELECT c.slug AS slug, c.updated_at AS updated_at,
              (SELECT MAX(i.started_at) FROM routine_run_items i
                 JOIN routine_runs r ON r.id = i.run_id
                WHERE i.case_slug = c.slug AND r.routine_id = ?) AS last_attempt_at,
              c.tags AS tags
         FROM cases c
        WHERE ${where.join(' AND ')}
        ORDER BY c.updated_at ASC`
    )
    .all(...args) as unknown as (Row & { tags: string })[]

  // Tag matching happens here rather than in SQL: `tags` is a JSON array in a TEXT column, and a
  // LIKE against it would match `severity:high` inside `severity:highest`.
  const wanted = scope.tags
  return rows
    .filter((r) => {
      if (!wanted?.length) return true
      let tags: string[]
      try {
        tags = JSON.parse(r.tags) as string[]
      } catch {
        return false
      }
      return wanted.some((t) => tags.includes(t))
    })
    .map((r) => ({
      slug: r.slug,
      updatedAt: r.updated_at,
      lastAttemptAt: r.last_attempt_at
    }))
}
