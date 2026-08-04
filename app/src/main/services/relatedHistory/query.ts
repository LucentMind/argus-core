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

/** Sources strong enough to justify a hit on their own (spec §4.3): a verbatim
 *  error string, a distilled signature token, or an exact ticket key is a real
 *  signal, unlike a word from a free-text title. */
const STRONG_SOURCES: readonly QueryTermSource[] = ['signature', 'errorStrings', 'jiraKey']

export function isStrong(term: QueryTerm): boolean {
  return STRONG_SOURCES.includes(term.source)
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
