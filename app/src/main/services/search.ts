import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactType, SearchFilters, SearchHit } from '../../shared/types'
import { caseDir } from './paths'

const MAX_READ_BYTES = 2 * 1024 * 1024

function escapeFtsQuery(q: string): string {
  // Escape FTS special characters but preserve the query as individual terms
  // This allows per-term highlighting while preventing syntax errors
  const trimmed = q.trim()
  // Escape problematic FTS syntax characters by wrapping terms in quotes
  // Split by whitespace and wrap each term in quotes
  const terms = trimmed.split(/\s+/).map(term => {
    // Escape internal quotes by doubling them
    const escaped = term.replace(/"/g, '""')
    // Wrap in quotes to protect special characters
    return '"' + escaped + '"'
  })
  return terms.join(' ')
}

interface HitRow {
  evidenceId: number
  caseSlug: string
  relPath: string
  artifactType: string
  snippet: string
  startLine: number
  endLine: number
}

export function searchEvidence(db: DatabaseSync, query: string, filters: SearchFilters = {}): SearchHit[] {
  if (!query.trim()) return []
  const caseSlug = filters.caseSlug ?? null
  const artifactType = filters.artifactType ?? null
  const rows = db
    .prepare(
      `SELECT evidence_fts.evidence_id AS evidenceId,
              c.slug                    AS caseSlug,
              e.rel_path                AS relPath,
              e.artifact_type           AS artifactType,
              snippet(evidence_fts, 0, '«', '»', '…', 12) AS snippet,
              evidence_fts.start_line   AS startLine,
              evidence_fts.end_line     AS endLine
       FROM evidence_fts
       JOIN evidence e ON e.id = evidence_fts.evidence_id
       JOIN cases c    ON c.id = e.case_id
       WHERE evidence_fts MATCH ?
         AND (? IS NULL OR c.slug = ?)
         AND (? IS NULL OR e.artifact_type = ?)
       ORDER BY bm25(evidence_fts)
       LIMIT 50`
    )
    .all(escapeFtsQuery(query), caseSlug, caseSlug, artifactType, artifactType) as unknown as HitRow[]
  return rows.map((r) => ({
    evidenceId: Number(r.evidenceId),
    caseSlug: r.caseSlug,
    relPath: r.relPath,
    artifactType: r.artifactType as ArtifactType,
    snippet: r.snippet,
    startLine: Number(r.startLine),
    endLine: Number(r.endLine)
  }))
}

export function readEvidenceText(
  db: DatabaseSync,
  argusHome: string,
  evidenceId: number
): { relPath: string; caseSlug: string; content: string } {
  const row = db
    .prepare(
      `SELECT e.rel_path AS relPath, c.slug AS caseSlug
       FROM evidence e JOIN cases c ON c.id = e.case_id WHERE e.id = ?`
    )
    .get(evidenceId) as { relPath: string; caseSlug: string } | undefined
  if (!row) throw new Error(`Unknown evidence id: ${evidenceId}`)
  const abs = path.join(caseDir(argusHome, row.caseSlug), row.relPath)
  const stat = fs.statSync(abs)
  let content: string
  if (stat.size > MAX_READ_BYTES) {
    const fd = fs.openSync(abs, 'r')
    try {
      const buf = Buffer.alloc(MAX_READ_BYTES)
      fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0)
      content = buf.toString('utf8') + '\n… [truncated]'
    } finally {
      fs.closeSync(fd)
    }
  } else {
    content = fs.readFileSync(abs, 'utf8')
  }
  return { relPath: row.relPath, caseSlug: row.caseSlug, content }
}
