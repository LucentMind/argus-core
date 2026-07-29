import type { DatabaseSync } from 'node:sqlite'
import type { PrCheck, PrStatus } from '../../shared/prStatus'

/**
 * The DB half of the PR/CI companion: no network, no orchestration. Everything that renders a
 * PR or CI state — the companion section, the header chip, the dashboard dots — reads here, and
 * only `prStatusService.refreshPrStatuses` writes.
 */

export function writePrStatus(db: DatabaseSync, caseSlug: string, status: PrStatus): void {
  const row = db.prepare(`SELECT id FROM cases WHERE slug = ?`).get(caseSlug) as
    { id: number } | undefined
  if (!row) return
  db.prepare(
    `INSERT INTO pr_status_cache (case_id, fetched_at, status_json) VALUES (?, ?, ?)
     ON CONFLICT(case_id) DO UPDATE SET fetched_at = excluded.fetched_at,
                                        status_json = excluded.status_json`
  ).run(row.id, status.fetchedAt, JSON.stringify(status))
}

/**
 * A cached row is whatever shape `PrStatus` had when it was written. `pr_status_cache` holds
 * JSON, so a field added later is simply absent from older rows — and the dashboard renders
 * the cache before the first refresh lands, so those rows do reach the UI. Normalizing here
 * keeps every consumer free of `?? false` guards.
 */
type CachedCheck = Omit<PrCheck, 'required'> & { required?: boolean }
type CachedStatus = Omit<PrStatus, 'checks' | 'mergeStateStatus'> & {
  checks: CachedCheck[]
  mergeStateStatus?: PrStatus['mergeStateStatus']
}

function normalize(s: CachedStatus): PrStatus {
  return {
    ...s,
    mergeStateStatus: s.mergeStateStatus ?? 'UNKNOWN',
    checks: s.checks.map((c) => ({ ...c, required: c.required ?? false }))
  }
}

/**
 * Cached statuses for the given cases, keyed by slug. A case with no cached row is ABSENT from
 * the result rather than mapped to null, so a caller cannot accidentally render "unknown" and
 * "not fetched yet" as the same thing.
 */
export function readPrStatuses(db: DatabaseSync, caseSlugs: string[]): Record<string, PrStatus> {
  if (caseSlugs.length === 0) return {}
  const placeholders = caseSlugs.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT c.slug AS slug, p.status_json AS status_json
         FROM pr_status_cache p JOIN cases c ON c.id = p.case_id
        WHERE c.slug IN (${placeholders})`
    )
    .all(...caseSlugs) as { slug: string; status_json: string }[]
  const out: Record<string, PrStatus> = {}
  for (const r of rows) out[r.slug] = normalize(JSON.parse(r.status_json) as CachedStatus)
  return out
}

/** Drop a case's cached status. Called when its binding changes — see prBindings.ts. */
export function clearPrStatus(db: DatabaseSync, caseSlug: string): void {
  db.prepare(
    `DELETE FROM pr_status_cache WHERE case_id IN (SELECT id FROM cases WHERE slug = ?)`
  ).run(caseSlug)
}
