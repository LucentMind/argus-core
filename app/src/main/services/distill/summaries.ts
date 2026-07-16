import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  CaseDistillSummary,
  CaseSummaryRecord,
  SummarySearchHit
} from '../../../shared/distill'
import { caseDir } from '../paths'
import { getCase } from '../caseService'

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

export function searchCaseSummaries(
  db: DatabaseSync,
  query: string,
  opts: { limit?: number; excludeSlug?: string } = {}
): SummarySearchHit[] {
  const limit = opts.limit ?? 5
  const exclude = opts.excludeSlug ?? null
  try {
    // Use prefix matching with explicit OR for flexible matching
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `${t}*`)
      .join(' OR ')
    const rows = db
      .prepare(
        `SELECT f.case_slug AS caseSlug, s.signature, s.resolution,
              snippet(case_summaries_fts, 0, '«', '»', '…', 12) AS snippet
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

export function similarCases(db: DatabaseSync, caseSlug: string): SummarySearchHit[] {
  const c = getCase(db, caseSlug)
  if (!c) return []
  const query = [c.title, c.jiraKey].filter(Boolean).join(' ')
  if (!query.trim()) return []
  return searchCaseSummaries(db, query, { limit: 3, excludeSlug: caseSlug })
}
