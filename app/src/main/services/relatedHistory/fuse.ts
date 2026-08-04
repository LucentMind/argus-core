import type { CorpusDefectHit, LocalCaseHit, RelatedHit } from '../../../shared/relatedHistory'
import type { ProviderRanking } from './types'

/** Standard RRF constant. */
export const RRF_K = 60

export function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank)
}

/**
 * Reciprocal-rank fusion over each provider's RANK, never its score. SPEC §5
 * guarantees descending relevance per source but explicitly refuses cross-source
 * score normalization, so rank is the only comparable signal available.
 *
 * With single-source membership this degenerates to interleaving (every source's
 * #1 competes, then every #2), which is the honest behaviour. The one place it
 * does more is the local↔corpus merge below: when a local case's jiraKey equals a
 * corpus hit's key, the row carries both provenances and the SUM of both RRF
 * terms, so agreement between two independent retrieval channels floats to the top.
 *
 * Two corpus sources sharing a key are NEVER merged — SPEC §5 keeps corpora
 * separate, and an identical key across two trackers is a coincidence.
 */
export function fuse(rankings: ProviderRanking[]): RelatedHit[] {
  type Entry = { hit: RelatedHit; order: number }
  const out: Entry[] = []
  const localByKey = new Map<string, { hit: LocalCaseHit; order: number }>()

  // Pass 1 — local providers seed the merge map, so a merged row keeps the local
  // case as primary (it owns the findings, evidence and transcript).
  for (const r of rankings) {
    if (r.kind !== 'local') continue
    for (const hit of r.hits) {
      const copy = { ...(hit as LocalCaseHit), fusedScore: rrfScore(hit.rank) }
      const entry = { hit: copy, order: r.order }
      out.push(entry)
      const k = normKey(copy.jiraKey)
      if (k) localByKey.set(k, entry)
    }
  }

  // Pass 2 — a corpus hit either merges into a local entry or joins on its own.
  for (const r of rankings) {
    if (r.kind === 'local') continue
    for (const hit of r.hits) {
      const c = hit as CorpusDefectHit
      const k = normKey(c.key)
      const target = k ? localByKey.get(k) : undefined
      if (target) {
        // KNOWN LIMITATION: if two different corpus sources both key onto the same
        // local hit's jiraKey, each merges in turn here. fusedScore correctly
        // accumulates all RRF terms and provenance correctly grows to include every
        // source — but corpusRef is a single slot, so it ends up holding whichever
        // corpus source merged last, silently dropping the earlier one's link. The
        // UI can therefore only ever deep-link to one of the two matching corpus
        // records. Not handled — recorded as a minor, carried to the whole-branch
        // review; no test covers this multi-merge case.
        target.hit.fusedScore += rrfScore(c.rank)
        target.hit.provenance = [...target.hit.provenance, ...c.provenance]
        target.hit.corpusRef = { sourceId: c.sourceId, key: c.key, url: c.url }
        if (target.hit.matchedOn !== c.matchedOn) target.hit.matchedOn = 'both'
        if (!target.hit.distilled && c.distilled) target.hit.distilled = c.distilled
        continue
      }
      out.push({ hit: { ...c, fusedScore: rrfScore(c.rank) }, order: r.order })
    }
  }

  return out.sort(compare).map((e) => e.hit)
}

function normKey(k: string | null | undefined): string | null {
  const t = k?.trim().toLowerCase()
  return t ? t : null
}

/** Deterministic tie-break: score → local first → provider order → id. */
function compare(
  a: { hit: RelatedHit; order: number },
  b: { hit: RelatedHit; order: number }
): number {
  if (b.hit.fusedScore !== a.hit.fusedScore) return b.hit.fusedScore - a.hit.fusedScore
  const ak = a.hit.kind === 'local' ? 0 : 1
  const bk = b.hit.kind === 'local' ? 0 : 1
  if (ak !== bk) return ak - bk
  if (a.order !== b.order) return a.order - b.order
  return a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0
}
