import { ARTIFACTS_PREFIX, type EvidenceScope } from '../../shared/evidenceScope'

const ARTIFACTS_LIKE = `${ARTIFACTS_PREFIX}%`

/**
 * The `rel_path` predicate for a listing or search scope: a fragment appended to a WHERE
 * clause that already aliases the evidence table as `e`, plus the params it binds.
 *
 * Both listEvidence() and searchEvidence() read the predicate from here so the two cannot
 * drift, and so the `artifacts/` prefix keeps its single definition in shared/evidenceScope.
 * Spread `params` LAST into the statement — the fragment's placeholder is appended after
 * whatever the caller already binds.
 *
 * Two misuses fail silently rather than throwing, so a third consumer must check both: spreading
 * `params` anywhere but last shifts every binding, and appending to a WHERE whose top level holds
 * an unparenthesized OR scopes the predicate to the last disjunct only (AND binds tighter) —
 * which leaks. Append only to a top-level AND chain. A wrong table alias, by contrast, fails
 * loudly on the first prepare().
 */
export function scopeClause(scope: EvidenceScope): { sql: string; params: string[] } {
  if (scope === 'all') return { sql: '', params: [] }
  const op = scope === 'review' ? 'LIKE' : 'NOT LIKE'
  return { sql: ` AND e.rel_path ${op} ?`, params: [ARTIFACTS_LIKE] }
}
