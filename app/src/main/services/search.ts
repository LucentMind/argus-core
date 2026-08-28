import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactType, SearchFilters, SearchHit, SearchResult } from '../../shared/types'
import {
  SNIPPET_BEFORE,
  SNIPPET_AFTER,
  MAX_SNIPPET_LINES,
  langForPath
} from '../../shared/snippets'
import type { SnippetResult } from '../../shared/snippets'
import { MAX_WHOLE_FILE_BYTES } from '../../shared/textdoc'
import { caseDir } from './paths'
import { scopeClause } from './evidenceScopeSql'
import { countPendingIndex } from './indexState'
import { renderSnippet } from './snippet'
import { getLines, loadIndexSync } from './lineIndex'
import { legacyEvidenceIndexExists } from './ftsIndex'

export const MAX_READ_BYTES = MAX_WHOLE_FILE_BYTES
// window around a citation's target line, for files too big to load whole
export const WINDOW_LINES_BEFORE = 500
export const WINDOW_LINES_AFTER = 2000
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

interface LocatorRow {
  evidenceId: number
  caseSlug: string
  relPath: string
  artifactType: string
  startLine: number
  endLine: number
  rank: number
}

/** Marker shown when the indexed file is no longer on disk. The index still knows the
 *  chunk matched; only the text to quote is gone. Silence here would be indistinguishable
 *  from a chunk that legitimately rendered empty. */
export const MISSING_FILE_SNIPPET = '[file missing — rescan or remove]'

/**
 * Fetch one chunk's text back off disk.
 *
 * Prefers lineIndex.getLines, which seeks to the nearest checkpoint and reads at most
 * (checkpoint gap + range) lines. readLineWindow is the fallback and scans from byte 0.
 * That fallback is NOT bounded by file size: loadIndexSync returns null whenever no
 * sidecar exists OR the sidecar disagrees with the file's current mtime/size, and a
 * multi-hundred-megabyte file that has just been rewritten hits exactly that case. The
 * preference is therefore a large win on the common path (the average artifact in the
 * installation this targets would otherwise cost a 27 MB scan per hit) and not a
 * guarantee; the fallback's worst case is one full scan of the file, once per hit, until
 * the re-index rewrites the sidecar.
 *
 * Never throws: a hit with no snippet is worth more than an exception that loses the
 * other 49.
 *
 * Reports `missing` for an EMPTY result from an otherwise successful read, not just for a
 * failed one. A file that still exists but got SHORTER — evidence content updated, or a
 * Rescan, both of which rewrite the file before the background re-index catches up —
 * leaves stale chunks whose window is entirely past EOF. existsSync passes, the read
 * succeeds and returns nothing, and renderSnippet('') is '': a blank snippet, which is the
 * exact NULL-lookalike reading from disk exists to avoid.
 */
function chunkText(
  argusHome: string,
  caseSlug: string,
  relPath: string,
  startLine: number,
  endLine: number
): { text: string; missing: boolean } {
  const abs = path.join(caseDir(argusHome, caseSlug), ...relPath.split('/'))
  if (!fs.existsSync(abs)) return { text: '', missing: true }
  try {
    const index = loadIndexSync(argusHome, abs)
    const text = index
      ? getLines(index, abs, startLine, endLine).lines.join('\n')
      : readLineWindow(abs, startLine, endLine).content
    // An indexed chunk always had text; nothing coming back means the lines it points at
    // are no longer there.
    return text === '' ? { text: '', missing: true } : { text, missing: false }
  } catch {
    // Any read failure renders the marker, never a blank. A blank snippet is
    // indistinguishable from the contentless snippet() NULL this whole read-from-disk
    // path exists to avoid — and the earlier existsSync check cannot cover a permission
    // error, or the file vanishing between that check and this read.
    return { text: '', missing: true }
  }
}

export function searchEvidence(
  db: DatabaseSync,
  argusHome: string,
  query: string,
  filters: SearchFilters = {}
): SearchHit[] {
  if (!query.trim()) return []
  const caseSlug = filters.caseSlug ?? null
  const artifactType = filters.artifactType ?? null
  // Default 'investigation': see SearchFilters.evidenceScope. The clause sits inside the
  // WHERE rather than filtering the result array, so an investigation search never spends
  // its 50 slots on artifact rows that are then discarded.
  const scope = scopeClause(filters.evidenceScope ?? 'investigation')
  const match = escapeFtsQuery(query)

  // Two generations are queried and merged while the migration runs (see
  // evidenceIndexMigration.ts). bm25 is per-table, so the merged ordering is approximate
  // for the duration; once the legacy table is empty this collapses to one query and the
  // approximation disappears. Both sides carry the same filters so neither can spend its
  // 50 slots on rows the other would have excluded.
  const current = db
    .prepare(
      `SELECT m.evidence_id      AS evidenceId,
              c.slug             AS caseSlug,
              e.rel_path         AS relPath,
              e.artifact_type    AS artifactType,
              m.start_line       AS startLine,
              m.end_line         AS endLine,
              bm25(evidence_index) AS rank
       FROM evidence_index
       JOIN evidence_index_map m ON m.fts_rowid = evidence_index.rowid
       JOIN evidence e ON e.id = m.evidence_id
       JOIN cases c    ON c.id = e.case_id
       WHERE evidence_index MATCH ?
         AND (? IS NULL OR c.slug = ?)
         AND (? IS NULL OR e.artifact_type = ?)${scope.sql}
       ORDER BY rank
       LIMIT 50`
    )
    .all(
      match,
      caseSlug,
      caseSlug,
      artifactType,
      artifactType,
      ...scope.params
    ) as unknown as LocatorRow[]

  // finalizeEvidenceIndexMigration DROPs the legacy tables once the migration finishes, and
  // db.ts no longer recreates them — so on a fresh install they never existed, and on a
  // migrated one they are gone for good. Preparing a statement against a table that is not
  // there throws "no such table", which would break every search from that point on. Probe
  // first, through the one shared predicate in ftsIndex.ts; the lookup is against the
  // in-memory schema and is negligible beside the FTS query.
  const legacy = !legacyEvidenceIndexExists(db)
    ? []
    : (db
        .prepare(
          `SELECT evidence_fts.evidence_id AS evidenceId,
              c.slug                   AS caseSlug,
              e.rel_path               AS relPath,
              e.artifact_type          AS artifactType,
              evidence_fts.start_line  AS startLine,
              evidence_fts.end_line    AS endLine,
              bm25(evidence_fts)       AS rank
       FROM evidence_fts
       JOIN evidence e ON e.id = evidence_fts.evidence_id
       JOIN cases c    ON c.id = e.case_id
       WHERE evidence_fts MATCH ?
         AND (? IS NULL OR c.slug = ?)
         AND (? IS NULL OR e.artifact_type = ?)${scope.sql}
       ORDER BY rank
       LIMIT 50`
        )
        .all(
          match,
          caseSlug,
          caseSlug,
          artifactType,
          artifactType,
          ...scope.params
        ) as unknown as LocatorRow[])

  const merged = [...current, ...legacy].sort((a, b) => a.rank - b.rank).slice(0, 50)

  const seen = new Set<string>()
  const hits: SearchHit[] = []
  for (const r of merged) {
    // A row mid-migration can exist in both tables; the same chunk must not be shown twice.
    const key = `${r.evidenceId}:${r.startLine}`
    if (seen.has(key)) continue
    seen.add(key)
    const { text, missing } = chunkText(argusHome, r.caseSlug, r.relPath, r.startLine, r.endLine)
    hits.push({
      evidenceId: Number(r.evidenceId),
      caseSlug: r.caseSlug,
      relPath: r.relPath,
      artifactType: r.artifactType as ArtifactType,
      snippet: missing ? MISSING_FILE_SNIPPET : renderSnippet(text, query),
      startLine: Number(r.startLine),
      endLine: Number(r.endLine),
      matchLine: findMatchLine(text, Number(r.startLine), query)
    })
  }
  return hits
}

/**
 * searchEvidence plus the count of files still being indexed.
 *
 * Background indexing means a search can run over a partially built index. Any
 * surface that shows results to a human or an agent must carry this count, or an
 * empty result reads as "there is nothing here" when it actually means "not yet".
 */
export function searchEvidenceWithStatus(
  db: DatabaseSync,
  argusHome: string,
  query: string,
  filters: SearchFilters = {}
): SearchResult {
  return {
    hits: searchEvidence(db, argusHome, query, filters),
    pendingIndexCount: countPendingIndex(db, filters.caseSlug ?? null)
  }
}

// Scans a file from the start counting newlines (never loading it whole),
// keeping only lines within [windowStart, windowEnd]. Splits on raw \n bytes
// so multi-byte UTF-8 characters are never decoded across a chunk boundary.
export function readLineWindow(
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
  // A file removed from under the case dir must not surface as an unhandled ENOENT: the
  // evidence row still exists and the viewer needs something to show. evidence:scan marks
  // such rows meta.missing, and readEvidenceSnippet already reports rather than throws.
  if (!fs.existsSync(abs)) {
    return {
      relPath: row.relPath,
      caseSlug: row.caseSlug,
      content: MISSING_FILE_SNIPPET,
      startLine: 1,
      truncated: false
    }
  }
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
  start: number,
  end: number = start
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
  const s = start > 0 ? start : 1
  const e = Math.max(end, s)
  const windowStart = Math.max(1, s - SNIPPET_BEFORE)
  const windowEnd = Math.min(e + SNIPPET_AFTER, windowStart + MAX_SNIPPET_LINES - 1)
  const { content, reachedEof } = readLineWindow(abs, windowStart, windowEnd)
  return {
    ok: true,
    evidenceId: Number(row.id),
    relPath,
    startLine: windowStart,
    lines: content === '' ? [] : content.split('\n'),
    lang: langForPath(relPath).lang,
    eof: reachedEof,
    truncated: e + SNIPPET_AFTER > windowEnd
  }
}
