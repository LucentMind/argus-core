import type { DatabaseSync } from 'node:sqlite'
import type {
  LocalCaseHit,
  RelatedDistilled,
  RelatedStatusTone
} from '../../../../shared/relatedHistory'
import {
  rankSlugs,
  summaryPopulation,
  termSlugSets,
  type SummaryRankRow
} from '../../distill/summaries'
import { isStrong, type RelatedQuery } from '../query'
import type { HistoryProvider, ProviderResult } from '../types'

export const LOCAL_PROVIDER_ID = 'local'
export const LOCAL_PROVIDER_NAME = 'Your cases'

/** Drop a term appearing in more than this share of the searchable population.
 *  Corpus-derived rather than a hand-written stopword list — an English wordlist
 *  would be the wrong instrument for a technical corpus, and this self-tunes. */
export const DF_SUPPRESS_RATIO = 0.3
/** Below this population the ratio would suppress nearly every term, so the rule
 *  is skipped entirely and the overlap rule carries the precision alone. */
export const DF_MIN_POPULATION = 4
/**
 * A term this rare is discriminative enough to justify a hit on its own.
 *
 * Note the interaction with DF_SUPPRESS_RATIO: below ~10 summaries the
 * suppression threshold (0.3 × population) sits at or under this value, so every
 * term that survives suppression is also "rare" and relaxes the overlap rule to
 * 1. That is intended — on a corpus that small, recall matters more and a wrong
 * row is cheap to dismiss — but it means the overlap rule only becomes the
 * deciding guard once the corpus passes roughly 10 summaries.
 */
export const RARE_DF = 2
/** Distinct surviving terms a case must match, unless it matched a strong or rare one. */
export const MIN_OVERLAP = 2

function localStatus(resolution: string): { label: string; tone: RelatedStatusTone } {
  if (resolution === 'forwarded') return { label: 'forwarded', tone: 'forwarded' }
  if (resolution === 'open') return { label: 'open', tone: 'open' }
  return { label: resolution, tone: 'resolved' }
}

function distilledFrom(row: SummaryRankRow): RelatedDistilled {
  let terms: string[] = []
  try {
    const parsed = JSON.parse(row.keywords) as unknown
    if (Array.isArray(parsed)) terms = parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    /* a corrupt keywords blob must not fail the whole search */
  }
  return {
    signature: row.signature,
    symptoms: row.symptoms,
    rootCause: row.rootCause || null,
    fix: row.fix || null,
    terms
  }
}

function toHit(row: SummaryRankRow, index: number): LocalCaseHit {
  return {
    kind: 'local',
    id: `${LOCAL_PROVIDER_ID}:${row.caseSlug}`,
    caseSlug: row.caseSlug,
    jiraKey: row.jiraKey,
    provenance: [
      { providerId: LOCAL_PROVIDER_ID, providerName: LOCAL_PROVIDER_NAME, kind: 'local' }
    ],
    title: row.signature,
    snippet: row.snippet ?? null,
    matchedOn: 'lexical',
    rank: index + 1,
    fusedScore: 0,
    status: localStatus(row.resolution),
    distilled: distilledFrom(row)
  }
}

/**
 * Local `case_summaries` retrieval with the four precision guards from spec §4.
 *
 * The old path OR-ed every title token as a prefix and returned anything that
 * matched, with bm25 only ORDERING the matched set — so one incidental word
 * ("tour", "case") produced a confident-looking hit. Rules 2 and 3 below are the
 * fix; no rule special-cases any slug.
 */
export function createLocalCasesProvider(
  db: DatabaseSync,
  excludeSlug: string | null
): HistoryProvider {
  return {
    id: LOCAL_PROVIDER_ID,
    name: LOCAL_PROVIDER_NAME,
    kind: 'local',
    async search(q: RelatedQuery, limit: number): Promise<ProviderResult> {
      try {
        if (q.terms.length === 0) return { ok: true, hits: [], reason: 'query-too-generic' }

        const population = summaryPopulation(db, true)
        const sets = termSlugSets(
          db,
          q.terms.map((t) => t.text),
          { excludeSlug, excludeOpen: true }
        )

        // Rule 2 — document-frequency suppression.
        const threshold = population * DF_SUPPRESS_RATIO
        const survivors = q.terms.filter((t) => {
          const df = sets.get(t.text)?.size ?? 0
          if (df === 0) return false
          if (population < DF_MIN_POPULATION) return true
          return df <= threshold
        })
        if (survivors.length === 0) return { ok: true, hits: [], reason: 'query-too-generic' }

        // Rule 3 — minimum overlap, relaxed for strong or rare terms.
        const matchCount = new Map<string, number>()
        const strongMatched = new Set<string>()
        for (const term of survivors) {
          const slugs = sets.get(term.text)!
          const relaxed = isStrong(term) || slugs.size <= RARE_DF
          for (const slug of slugs) {
            matchCount.set(slug, (matchCount.get(slug) ?? 0) + 1)
            if (relaxed) strongMatched.add(slug)
          }
        }
        const eligible = [...matchCount.entries()]
          .filter(([slug, n]) => n >= MIN_OVERLAP || strongMatched.has(slug))
          .map(([slug]) => slug)
        if (eligible.length === 0) return { ok: true, hits: [] }

        const rows = rankSlugs(
          db,
          survivors.map((t) => t.text),
          eligible,
          limit
        )
        return { ok: true, hits: rows.map(toHit) }
      } catch (err) {
        // Spec §4.6: a broken index must be visible, not masquerade as "no hits".
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  }
}
