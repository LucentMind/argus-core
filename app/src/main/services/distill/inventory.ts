import type { DatabaseSync } from 'node:sqlite'
import { ASSET_KINDS, type AssetInventoryEntry, type AssetKind } from '../../../shared/attribution'
import { USAGE_PREDICATES, EFFECTIVE_CALLS } from '../observability/usagePredicates'

interface CountRow {
  detail: string
  n: number
}
interface SeenRow {
  detail: string
  session_id: number
  turn_id: number | null
}

/** Every knowledge asset that appeared in this case's sessions, from `tool_calls` — the same
 *  predicates `usageStats()` uses. Snapshotted into `input_snapshot.assets` so the attribution
 *  stage replays byte-identically. Sorted callCount desc, then kind order, then name. */
export function buildAssetInventory(
  db: DatabaseSync,
  caseId: number,
  tiers: { skill: Map<string, string | null>; reference: Map<string, string | null> }
): AssetInventoryEntry[] {
  const out: AssetInventoryEntry[] = []
  const collect = (kind: AssetKind, where: string): void => {
    const counts = db
      .prepare(
        `SELECT detail, COUNT(*) AS n FROM tool_calls
         WHERE case_id = ? AND ${EFFECTIVE_CALLS} AND ${where}
         GROUP BY detail`
      )
      .all(caseId) as unknown as CountRow[]
    // Earliest effective call per detail wins (created_at, then id as the tie-break).
    const seen = db
      .prepare(
        `SELECT detail, session_id, turn_id FROM tool_calls
         WHERE case_id = ? AND ${EFFECTIVE_CALLS} AND ${where}
         ORDER BY created_at ASC, id ASC`
      )
      .all(caseId) as unknown as SeenRow[]
    const first = new Map<string, SeenRow>()
    for (const r of seen) if (!first.has(r.detail)) first.set(r.detail, r)
    for (const c of counts) {
      const f = first.get(c.detail)
      if (!f) continue
      const name = kind === 'reference' ? c.detail.slice('ref:'.length) : c.detail
      // A bare `ref:` (or an empty skill/memory detail) names no asset; graded, it would become an
      // empty-named row that matchAssetMention-style lookups can never tell apart from anything.
      if (!name) continue
      const tier = kind === 'memory' ? null : (tiers[kind].get(name) ?? null)
      out.push({
        kind,
        name,
        tier,
        callCount: c.n,
        firstSeen: { sessionId: f.session_id, turnId: f.turn_id }
      })
    }
  }
  collect('skill', USAGE_PREDICATES.skill)
  collect('reference', USAGE_PREDICATES.reference)
  collect('memory', USAGE_PREDICATES.memory)
  return out.sort(
    (a, b) =>
      b.callCount - a.callCount ||
      ASSET_KINDS.indexOf(a.kind) - ASSET_KINDS.indexOf(b.kind) ||
      a.name.localeCompare(b.name)
  )
}
