import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactType, SearchFilters, SearchHit } from '../../shared/types'
import { SNIPPET_BEFORE, SNIPPET_AFTER, langForPath } from '../../shared/snippets'
import type { SnippetResult } from '../../shared/snippets'
import { caseDir } from './paths'

const MAX_READ_BYTES = 2 * 1024 * 1024
// window around a citation's target line, for files too big to load whole
const WINDOW_LINES_BEFORE = 500
const WINDOW_LINES_AFTER = 2000
const SCAN_CHUNK_BYTES = 1024 * 1024

export function escapeFtsQuery(q: string): string {
  // Escape FTS special characters but preserve the query as individual terms
  // This allows per-term highlighting while preventing syntax errors
  const trimmed = q.trim()
  // Escape problematic FTS syntax characters by wrapping terms in quotes
  // Split by whitespace and wrap each term in quotes
  const terms = trimmed.split(/\s+/).map((term) => {
    // Escape internal quotes by doubling them
    const escaped = term.replace(/"/g, '""')
    // Wrap in quotes to protect special characters
    return '"' + escaped + '"'
  })
  return terms.join(' ')
}

// Locate the first line inside a chunk that contains all query terms
// (falling back to any term, then to the chunk start). FTS matches at chunk
// granularity; this recovers line granularity for viewer deep-links.
function findMatchLine(chunkContent: string, startLine: number, query: string): number {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return startLine
  const lines = chunkContent.split('\n')
  let anyTermIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase()
    if (terms.every((t) => line.includes(t))) return startLine + i
    if (anyTermIdx === -1 && terms.some((t) => line.includes(t))) anyTermIdx = i
  }
  return anyTermIdx >= 0 ? startLine + anyTermIdx : startLine
}

interface HitRow {
  evidenceId: number
  caseSlug: string
  relPath: string
  artifactType: string
  snippet: string
  startLine: number
  endLine: number
  chunkContent: string
}

export function searchEvidence(
  db: DatabaseSync,
  query: string,
  filters: SearchFilters = {}
): SearchHit[] {
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
              evidence_fts.end_line     AS endLine,
              evidence_fts.content      AS chunkContent
       FROM evidence_fts
       JOIN evidence e ON e.id = evidence_fts.evidence_id
       JOIN cases c    ON c.id = e.case_id
       WHERE evidence_fts MATCH ?
         AND (? IS NULL OR c.slug = ?)
         AND (? IS NULL OR e.artifact_type = ?)
       ORDER BY bm25(evidence_fts)
       LIMIT 50`
    )
    .all(
      escapeFtsQuery(query),
      caseSlug,
      caseSlug,
      artifactType,
      artifactType
    ) as unknown as HitRow[]
  return rows.map((r) => ({
    evidenceId: Number(r.evidenceId),
    caseSlug: r.caseSlug,
    relPath: r.relPath,
    artifactType: r.artifactType as ArtifactType,
    snippet: r.snippet,
    startLine: Number(r.startLine),
    endLine: Number(r.endLine),
    matchLine: findMatchLine(r.chunkContent, Number(r.startLine), query)
  }))
}

// Scans a file from the start counting newlines (never loading it whole),
// keeping only lines within [windowStart, windowEnd]. Splits on raw \n bytes
// so multi-byte UTF-8 characters are never decoded across a chunk boundary.
function readLineWindow(
  absPath: string,
  windowStart: number,
  windowEnd: number
): { content: string; endLine: number; reachedEof: boolean } {
  const fd = fs.openSync(absPath, 'r')
  try {
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES)
    let carry = Buffer.alloc(0)
    let lineNo = 0
    let offset = 0
    let reachedEof = false
    const collected: string[] = []
    while (true) {
      const n = fs.readSync(fd, chunk, 0, SCAN_CHUNK_BYTES, offset)
      if (n === 0) {
        reachedEof = true
        break
      }
      offset += n
      const data = Buffer.concat([carry, chunk.subarray(0, n)])
      let start = 0
      let nl = data.indexOf(0x0a, start)
      while (nl !== -1) {
        lineNo++
        if (lineNo >= windowStart && lineNo <= windowEnd) {
          collected.push(data.subarray(start, nl).toString('utf8'))
        }
        start = nl + 1
        nl = data.indexOf(0x0a, start)
      }
      carry = data.subarray(start)
      if (lineNo >= windowEnd) break
    }
    if (reachedEof && carry.length > 0) {
      lineNo++
      if (lineNo >= windowStart && lineNo <= windowEnd) collected.push(carry.toString('utf8'))
    }
    return { content: collected.join('\n'), endLine: Math.min(lineNo, windowEnd), reachedEof }
  } finally {
    fs.closeSync(fd)
  }
}

export function readEvidenceText(
  db: DatabaseSync,
  argusHome: string,
  evidenceId: number,
  focusLine?: number
): { relPath: string; caseSlug: string; content: string; startLine: number; truncated: boolean } {
  const row = db
    .prepare(
      `SELECT e.rel_path AS relPath, c.slug AS caseSlug
       FROM evidence e JOIN cases c ON c.id = e.case_id WHERE e.id = ?`
    )
    .get(evidenceId) as { relPath: string; caseSlug: string } | undefined
  if (!row) throw new Error(`Unknown evidence id: ${evidenceId}`)
  const abs = path.join(caseDir(argusHome, row.caseSlug), row.relPath)
  const stat = fs.statSync(abs)
  if (stat.size <= MAX_READ_BYTES) {
    const content = fs.readFileSync(abs, 'utf8')
    return { relPath: row.relPath, caseSlug: row.caseSlug, content, startLine: 1, truncated: false }
  }
  const target = focusLine && focusLine > 0 ? focusLine : 1
  const windowStart = Math.max(1, target - WINDOW_LINES_BEFORE)
  const windowEnd = target + WINDOW_LINES_AFTER
  const { content, endLine, reachedEof } = readLineWindow(abs, windowStart, windowEnd)
  if (content === '') {
    return {
      relPath: row.relPath,
      caseSlug: row.caseSlug,
      content: `[line ${target} does not exist in this file — it ends at line ${endLine}]`,
      startLine: 1,
      truncated: true
    }
  }
  const truncated = windowStart > 1 || !reachedEof
  return {
    relPath: row.relPath,
    caseSlug: row.caseSlug,
    content,
    startLine: windowStart,
    truncated
  }
}

/** Small windowed read for CitationCard previews: SNIPPET_BEFORE/AFTER lines
 *  around the cited line. Resolves relPath directly (no evidence.list roundtrip)
 *  and never throws — missing rows/files come back as { ok: false }. */
export function readEvidenceSnippet(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  relPath: string,
  line: number
): SnippetResult {
  const row = db
    .prepare(
      `SELECT e.id AS id FROM evidence e
       JOIN cases c ON c.id = e.case_id
       WHERE c.slug = ? AND e.rel_path = ?`
    )
    .get(caseSlug, relPath) as { id: number } | undefined
  if (!row) return { ok: false, reason: 'not-found' }
  const abs = path.join(caseDir(argusHome, caseSlug), relPath)
  if (!fs.existsSync(abs)) return { ok: false, reason: 'not-found' }
  const target = line > 0 ? line : 1
  const windowStart = Math.max(1, target - SNIPPET_BEFORE)
  const windowEnd = target + SNIPPET_AFTER
  const { content, reachedEof } = readLineWindow(abs, windowStart, windowEnd)
  return {
    ok: true,
    evidenceId: Number(row.id),
    relPath,
    startLine: windowStart,
    lines: content === '' ? [] : content.split('\n'),
    lang: langForPath(relPath).lang,
    eof: reachedEof
  }
}
