import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  CaseDistillSummary,
  CaseSummaryRecord,
  SummarySearchHit
} from '../../../shared/distill'
import { caseDir } from '../paths'

export function renderSummaryMarkdown(
  s: CaseDistillSummary,
  meta: { slug: string; title: string; jiraKey: string | null; resolution: string }
): string {
  return [
    `# Case summary — ${meta.title}`,
    ``,
    `**Signature:** ${s.signature}`,
    `**Resolution:** ${meta.resolution} · **Jira:** ${meta.jiraKey ?? '—'} · **Case:** ${meta.slug}`,
    ``,
    `## Symptoms`,
    ``,
    s.symptoms,
    ``,
    `## Root cause`,
    ``,
    s.rootCause,
    ``,
    `## Fix`,
    ``,
    s.fix,
    ``,
    `**Keywords:** ${s.keywords.join(', ')}`,
    ``
  ].join('\n')
}

export function upsertCaseSummary(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  summary: CaseDistillSummary,
  resolution: string,
  markdown: string
): CaseSummaryRecord {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO case_summaries (case_slug, signature, symptoms, root_cause, fix, keywords, resolution, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(case_slug) DO UPDATE SET signature=excluded.signature, symptoms=excluded.symptoms,
       root_cause=excluded.root_cause, fix=excluded.fix, keywords=excluded.keywords,
       resolution=excluded.resolution, accepted_at=excluded.accepted_at`
  ).run(
    caseSlug,
    summary.signature,
    summary.symptoms,
    summary.rootCause,
    summary.fix,
    JSON.stringify(summary.keywords),
    resolution,
    now
  )
  db.prepare(`DELETE FROM case_summaries_fts WHERE case_slug = ?`).run(caseSlug)
  db.prepare(
    `INSERT INTO case_summaries_fts (signature, symptoms, root_cause, fix, keywords, case_slug)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    summary.signature,
    summary.symptoms,
    summary.rootCause,
    summary.fix,
    summary.keywords.join(' '),
    caseSlug
  )
  fs.writeFileSync(path.join(caseDir(argusHome, caseSlug), 'summary.md'), markdown)
  return getCaseSummary(db, caseSlug)!
}

export function getCaseSummary(db: DatabaseSync, caseSlug: string): CaseSummaryRecord | null {
  const r = db.prepare(`SELECT * FROM case_summaries WHERE case_slug = ?`).get(caseSlug) as
    | {
        case_slug: string
        signature: string
        symptoms: string
        root_cause: string
        fix: string
        keywords: string
        resolution: string
        accepted_at: string
      }
    | undefined
  if (!r) return null
  return {
    caseSlug: r.case_slug,
    signature: r.signature,
    symptoms: r.symptoms,
    rootCause: r.root_cause,
    fix: r.fix,
    keywords: JSON.parse(r.keywords) as string[],
    resolution: r.resolution,
    acceptedAt: r.accepted_at
  }
}

// Builds an FTS5 MATCH expression from free-text user input: each whitespace
// token becomes a quoted phrase-prefix (`"<escaped>"*`), OR-joined. Quoting
// every token (with internal `"` doubled per FTS5 escaping rules) prevents
// ordinary punctuation — e.g. `reset():` — from being parsed as FTS5 syntax,
// and prevents a `word:` token from being read as a column filter. Returns
// null for blank/empty input so callers can skip the query entirely.
function buildPrefixMatchQuery(query: string): string | null {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ')
}

export function searchCaseSummaries(
  db: DatabaseSync,
  query: string,
  opts: { limit?: number; excludeSlug?: string } = {}
): SummarySearchHit[] {
  const limit = opts.limit ?? 5
  const exclude = opts.excludeSlug ?? null
  const ftsQuery = buildPrefixMatchQuery(query)
  if (!ftsQuery) return []
  try {
    const rows = db
      .prepare(
        `SELECT f.case_slug AS caseSlug, s.signature, s.resolution,
              snippet(case_summaries_fts, -1, '«', '»', '…', 12) AS snippet
       FROM case_summaries_fts f JOIN case_summaries s ON s.case_slug = f.case_slug
       WHERE case_summaries_fts MATCH ? AND (? IS NULL OR f.case_slug <> ?)
       ORDER BY bm25(case_summaries_fts) LIMIT ?`
      )
      .all(ftsQuery, exclude, exclude, limit)
    return rows as unknown as SummarySearchHit[]
  } catch {
    return []
  }
}

/**
 * A term for `termSlugSets`/`rankSlugs`. Plain strings default to the usual
 * prefix match; pass `{ text, exact: true }` for a term whose match mode must
 * be threaded through instead of special-cased at the call site — currently
 * only a `jiraKey` term (see `localCases.ts`), since FTS5's own tokenizer
 * splits a key like "KAN-4" into `[kan, 4]` and a trailing-token PREFIX would
 * then match "KAN-42", "KAN-420", "KAN-4299" — reintroducing exactly the
 * single-incidental-token false positive this feature exists to stop. An
 * EXACT quoted phrase (no trailing `*`) has no such collision.
 */
export interface TermMatch {
  text: string
  exact?: boolean
}

export type TermInput = string | TermMatch

function normalizeTerm(t: TermInput): TermMatch {
  return typeof t === 'string' ? { text: t } : t
}

/** One quoted phrase term, prefix by default. Quoting (doubling internal `"`)
 *  stops ordinary punctuation (`reset():`) being read as FTS5 syntax and stops
 *  a `word:` token being read as a column filter — for both match modes. */
function ftsTerm(t: TermMatch): string {
  const quoted = `"${t.text.replace(/"/g, '""')}"`
  return t.exact ? quoted : `${quoted}*`
}

/**
 * Size of the searchable summary population — the denominator for the
 * document-frequency suppression rule (spec §4.2). `excludeOpen` drops the
 * `resolution = 'open'` rows staging.ts writes for still-live cases, so the
 * denominator matches the population the search actually runs against.
 */
export function summaryPopulation(db: DatabaseSync, excludeOpen: boolean): number {
  const sql = excludeOpen
    ? `SELECT COUNT(*) AS n FROM case_summaries WHERE resolution <> 'open'`
    : `SELECT COUNT(*) AS n FROM case_summaries`
  return (db.prepare(sql).get() as unknown as { n: number }).n
}

/**
 * For each term, the set of case slugs whose summary matches it — one FTS5
 * query per term (terms are few, titles are short). Prefix by default; pass
 * `{ text, exact: true }` for a term that must match verbatim (see
 * `TermMatch`). The result yields BOTH document frequency (set size) and
 * per-slug matched-term counts (membership), which is what lets the local
 * provider apply suppression and overlap in a single pass.
 *
 * Deliberately does NOT catch per term. `ftsTerm` quotes every character
 * (doubling internal `"`), so there is no input string that turns into invalid
 * FTS5 syntax — a term FTS5 "cannot parse" is not a reachable case, only a term
 * that parses to a phrase matching zero rows. A throw here therefore means a
 * genuinely broken index (e.g. a missing/corrupt fts5 shadow table), and per
 * spec §4.6 that must propagate to the caller's own try/catch and surface as
 * `{ ok: false, error }`, not silently degrade every term to an empty set and
 * report "no similar cases".
 */
export function termSlugSets(
  db: DatabaseSync,
  terms: TermInput[],
  opts: { excludeSlug?: string | null; excludeOpen?: boolean } = {}
): Map<string, Set<string>> {
  const exclude = opts.excludeSlug ?? null
  const excludeOpen = opts.excludeOpen === false ? 0 : 1
  const stmt = db.prepare(
    `SELECT f.case_slug AS slug
       FROM case_summaries_fts f JOIN case_summaries s ON s.case_slug = f.case_slug
      WHERE case_summaries_fts MATCH ?
        AND (? IS NULL OR f.case_slug <> ?)
        AND (? = 0 OR s.resolution <> 'open')`
  )
  const out = new Map<string, Set<string>>()
  for (const term of terms) {
    const norm = normalizeTerm(term)
    const set = new Set<string>()
    for (const r of stmt.all(ftsTerm(norm), exclude, exclude, excludeOpen) as unknown as Array<{
      slug: string
    }>) {
      set.add(r.slug)
    }
    out.set(norm.text, set)
  }
  return out
}

/** A ranked summary row, carrying everything needed to build a RelatedHit
 *  without an N+1 query per hit. `keywords` is still the stored JSON string. */
export interface SummaryRankRow {
  caseSlug: string
  signature: string
  symptoms: string
  rootCause: string
  fix: string
  keywords: string
  resolution: string
  snippet: string
  jiraKey: string | null
}

/**
 * bm25-rank an EXPLICIT slug set. Callers have already decided which cases are
 * eligible (suppression + overlap); this only orders them.
 *
 * Deliberately does NOT catch: a throw here is a real index failure and spec
 * §4.6 requires it to surface rather than masquerade as "no similar cases".
 */
export function rankSlugs(
  db: DatabaseSync,
  terms: TermInput[],
  slugs: string[],
  limit: number
): SummaryRankRow[] {
  if (terms.length === 0 || slugs.length === 0) return []
  const ftsQuery = terms.map(normalizeTerm).map(ftsTerm).join(' OR ')
  const placeholders = slugs.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT f.case_slug AS caseSlug, s.signature, s.symptoms,
              s.root_cause AS rootCause, s.fix, s.keywords, s.resolution,
              snippet(case_summaries_fts, -1, '«', '»', '…', 12) AS snippet,
              c.jira_key AS jiraKey
         FROM case_summaries_fts f
         JOIN case_summaries s ON s.case_slug = f.case_slug
         LEFT JOIN cases c ON c.slug = f.case_slug
        WHERE case_summaries_fts MATCH ? AND f.case_slug IN (${placeholders})
        ORDER BY bm25(case_summaries_fts) LIMIT ?`
    )
    .all(ftsQuery, ...slugs, limit)
  return rows as unknown as SummaryRankRow[]
}
