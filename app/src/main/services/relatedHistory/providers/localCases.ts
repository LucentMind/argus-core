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
import { isExactMatch, isStrong, type RelatedQuery } from '../query'
import type { HistoryProvider, ProviderResult } from '../types'

export const LOCAL_PROVIDER_ID = 'local'
export const LOCAL_PROVIDER_NAME = 'Your cases'

/** Drop a term appearing in more than this share of the searchable population.
 *  Corpus-derived rather than a hand-written stopword list — an English wordlist
 *  would be the wrong instrument for a technical corpus, and this self-tunes. */
export const DF_SUPPRESS_RATIO = 0.3
/**
 * A floor under the suppression threshold rather than a population bypass. At
 * population < 4 a 0.3 ratio yields a threshold under 1 (e.g. 0.9 at
 * population 3), which would suppress EVERY term including one that appears
 * in exactly one summary — the previous code special-cased this away entirely
 * below `population < 4`, but that let two prefix-matched generic words
 * (e.g. "case" and "Sample:"->"sampled") each survive unsuppressed and
 * satisfy MIN_OVERLAP via legitimate-looking overlap on a tiny, real
 * first-week corpus. A floor of 1 keeps a genuinely rare (df=1) term alive
 * while still suppressing anything appearing in 2+ summaries of a small
 * corpus — which is what actually matters at this population size.
 */
export const DF_SUPPRESS_FLOOR = 1
/**
 * A strong-source term this rare is decisive evidence on its own — a verbatim
 * error string or an exact ticket key that appears in only a couple of
 * summaries is not shared vocabulary, it is the same incident. A strong term
 * that is common in the corpus (e.g. a signature word repeated across a fifth
 * of the cases) is NOT decisive by itself; it still needs a second overlapping
 * term. Rarity is necessary but never sufficient here — see Rule 3 below,
 * which ANDs this with `isStrong`, not ORs it.
 */
export const RARE_DF = 2
/** Distinct surviving terms a case must match, unless it matched a strong AND rare one. */
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
          q.terms.map((t) => ({ text: t.text, exact: isExactMatch(t) })),
          { excludeSlug, excludeOpen: true }
        )

        // Rule 2 — document-frequency suppression, floored rather than bypassed
        // at small populations (see DF_SUPPRESS_FLOOR).
        const threshold = Math.max(population * DF_SUPPRESS_RATIO, DF_SUPPRESS_FLOOR)
        const survivors = q.terms.filter((t) => {
          const df = sets.get(t.text)?.size ?? 0
          if (df === 0) return false
          return df <= threshold
        })
        if (survivors.length === 0) return { ok: true, hits: [], reason: 'query-too-generic' }

        // Rule 3 — minimum overlap, relaxed to 1 only for a term that is BOTH
        // strong-source (signature / errorStrings / jiraKey) AND rare (df <=
        // RARE_DF). Neither limb alone is enough: a non-strong term (title /
        // finding / free) must never relax regardless of how rare it is — that
        // is the spec §1 false positive this file exists to stop — and a strong
        // term that is common in the corpus (shared vocabulary, not a single
        // incident) still needs a second overlapping term too.
        const matchCount = new Map<string, number>()
        const strongMatched = new Set<string>()
        for (const term of survivors) {
          const slugs = sets.get(term.text)!
          const relaxed = isStrong(term) && slugs.size <= RARE_DF
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
          survivors.map((t) => ({ text: t.text, exact: isExactMatch(t) })),
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
