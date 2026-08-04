import type { DatabaseSync } from 'node:sqlite'
import { getCase } from '../caseService'
import { getCaseSummary } from '../distill/summaries'

export type QueryTermSource =
  'signature' | 'errorStrings' | 'title' | 'jiraKey' | 'finding' | 'free'

export interface QueryTerm {
  text: string
  source: QueryTermSource
}

export interface RelatedQuery {
  /** Whitespace-joined term text — what a corpus provider sends as `query`. */
  text: string
  terms: QueryTerm[]
}

/**
 * Sources strong enough to justify a hit on their own (spec §4.3): a verbatim
 * error string or an exact ticket key is decisive evidence, unlike a word
 * from a free-text title.
 *
 * `signature` deliberately does NOT get this: a distilled signature is
 * LLM-written prose, not a token list, and it contains ordinary articles and
 * prepositions ("bearing jumps north ON cold boot"). Measured regression (fix
 * pass 5): a querying case whose only overlap with an unrelated case was the
 * word "on" (df=2, rare enough) was returned as related history purely
 * because the term's source was `signature` and therefore counted as strong.
 * A single word out of prose is not the same kind of evidence as a verbatim
 * error string or an exact ticket key — it does not meet the "decisive on
 * its own" bar the single-term exception exists for. Signature-sourced terms
 * now need genuine 2-term overlap, same as title/finding/free — which is
 * nearly always available, since signatures are multi-word.
 */
const STRONG_SOURCES: readonly QueryTermSource[] = ['errorStrings', 'jiraKey']

export function isStrong(term: QueryTerm): boolean {
  return STRONG_SOURCES.includes(term.source)
}

/**
 * Sources matched EXACTLY (no trailing FTS5 `*`) rather than by prefix — every
 * source except `signature`/`errorStrings`.
 *
 * Prefix matching exists for morphological and partial-identifier recall on
 * DISTILLED, already-curated text: `E_TIMEOUT` finding `E_TIMEOUT_42`, or one
 * distilled signature's `reset` finding another's `resets`. A raw free-text
 * title or finding summary earns no such latitude — that is exactly where the
 * false-positive artefacts appear. `"Sample:"*` has no business matching
 * `sampled`: FTS5 tokenizes "Sample:" to `sample`, and the trailing star turns
 * that into a prefix that catches any longer word starting with it, purely by
 * morphological coincidence, not because the words are related. `jiraKey` is
 * exact for a different but compounding reason: FTS5 tokenizes "KAN-4" to
 * `[kan, 4]`, so a prefix match on the trailing token also matches "KAN-42",
 * "KAN-420", "KAN-4299" — sequential trackers mean any short key collides
 * with dozens of later ones.
 */
const EXACT_SOURCES: readonly QueryTermSource[] = ['title', 'finding', 'free', 'jiraKey']

export function isExactMatch(term: QueryTerm): boolean {
  return EXACT_SOURCES.includes(term.source)
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

/** Collects tokens in priority order, de-duplicating case-insensitively so the
 *  first (highest-priority) source wins for a repeated token. */
class TermCollector {
  private readonly seen = new Set<string>()
  readonly terms: QueryTerm[] = []

  push(raw: string, source: QueryTermSource): void {
    for (const tok of tokenize(raw)) {
      const k = tok.toLowerCase()
      if (this.seen.has(k)) continue
      this.seen.add(k)
      this.terms.push({ text: tok, source })
    }
  }

  build(): RelatedQuery {
    return { text: this.terms.map((t) => t.text).join(' '), terms: this.terms }
  }
}

/** The three most recent findings that still stand. A rejected finding, or one
 *  the agent filed as `ruled-out`, is a disproved hypothesis — it must not steer
 *  retrieval toward the thing the investigation already eliminated. */
export function recentFindingSummaries(db: DatabaseSync, caseId: number, limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT summary FROM findings
        WHERE case_id = ?
          AND review_state <> 'rejected'
          AND (role IS NULL OR role <> 'ruled-out')
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    )
    .all(caseId, limit) as unknown as Array<{ summary: string }>
  return rows.map((r) => r.summary)
}

/**
 * THE single source of truth for related-history query text (spec §4.1).
 *
 * Priority: an accepted summary's signature + distilled terms when the case has
 * one; otherwise title + jiraKey. Either way, up to three recent findings are
 * appended — an open case under investigation otherwise contributes only its
 * title, which is exactly the weak case that produced the false positives in
 * spec §1, and its findings are material already sitting in the case.
 */
export function buildRelatedQuery(db: DatabaseSync, caseSlug: string): RelatedQuery {
  const c = getCase(db, caseSlug)
  if (!c) return { text: '', terms: [] }
  const collector = new TermCollector()
  const summary = getCaseSummary(db, caseSlug)
  if (summary) {
    collector.push(summary.signature, 'signature')
    for (const term of summary.keywords) collector.push(term, 'errorStrings')
  } else {
    collector.push(c.title, 'title')
    if (c.jiraKey) collector.push(c.jiraKey, 'jiraKey')
  }
  for (const s of recentFindingSummaries(db, c.id, 3)) collector.push(s, 'finding')
  return collector.build()
}

/** A user-typed query. Terms are non-strong, so the same guards apply. */
export function freeFormQuery(text: string): RelatedQuery {
  const collector = new TermCollector()
  collector.push(text, 'free')
  return collector.build()
}
