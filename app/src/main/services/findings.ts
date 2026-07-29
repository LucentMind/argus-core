import type { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { FindingRow, ReviewState } from '../../shared/observability'
import { isReviewLayerId, isReviewSeverity } from '../../shared/reviewLayers'
import { DEFAULT_MODE, type ModeId } from '../../shared/modes'
import { caseDir } from './paths'
import { getCase } from './caseService'
import { appendDeletionAudit } from './deletionAudit'

export type { FindingRow, ReviewState }
const REVIEW_STATES: ReviewState[] = ['pending', 'accepted', 'rejected']

interface Raw {
  id: number
  case_id: number
  session_id: number | null
  turn_id: number | null
  summary: string
  review_state: string
  reviewed_at: string | null
  created_at: string
  layer: string | null
  severity: string | null
  diff_path: string | null
  diff_line: number | null
  suggested_change: string | null
  comment_url: string | null
  pushed_sha: string | null
  mode: string | null
}

function toRow(r: Raw): FindingRow {
  return {
    id: r.id,
    caseId: r.case_id,
    sessionId: r.session_id,
    turnId: r.turn_id,
    summary: r.summary,
    reviewState: r.review_state as ReviewState,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
    layer: isReviewLayerId(r.layer) ? r.layer : null,
    severity: isReviewSeverity(r.severity) ? r.severity : null,
    diffPath: r.diff_path,
    diffLine: r.diff_line,
    suggestedChange: r.suggested_change,
    commentUrl: r.comment_url,
    pushedSha: r.pushed_sha,
    // A finding whose session was deleted, or one written before the mode axis, has no mode
    // to join — it is investigation by the same rule that made investigation the implicit
    // default for every pre-existing case (spec §3).
    mode: (r.mode as ModeId | null) ?? DEFAULT_MODE
  }
}

// A finding's mode is derived by joining sessions.mode (never stored on the finding row
// itself), so every finding read goes through this LEFT JOIN. LEFT is load-bearing: an
// inner join would drop every session-less finding (deleted session, or pre-mode-axis rows).
const FINDINGS_WITH_MODE = `findings f LEFT JOIN sessions s ON s.id = f.session_id`

/** Parse findings.md into an id→body map using the `<!-- finding:{id} -->`
 *  markers appendFinding writes. Body is the markdown after the `## title` and
 *  `_meta_` lines. Findings written before markers existed simply won't match. */
export function parseFindingBodies(md: string): Map<number, string> {
  const map = new Map<number, string>()
  const parts = md.split(/<!-- finding:(\d+) -->/)
  // parts = [before, id1, segment1, id2, segment2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const id = Number(parts[i])
    const body = stripHeadingAndMeta(parts[i + 1] ?? '')
    if (body) map.set(id, body)
  }
  return map
}

function stripHeadingAndMeta(segment: string): string {
  const lines = segment.split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++ // leading blanks
  if (i < lines.length && lines[i].startsWith('## ')) i++ // heading
  if (i < lines.length && /^_.*_$/.test(lines[i].trim())) i++ // meta line
  return lines.slice(i).join('\n').trim()
}

export function listFindings(db: DatabaseSync, argusHome: string, caseSlug: string): FindingRow[] {
  const rows = (
    db
      .prepare(
        `SELECT f.*, s.mode AS mode FROM ${FINDINGS_WITH_MODE}
         JOIN cases c ON c.id = f.case_id
         WHERE c.slug = ? ORDER BY f.id DESC`
      )
      .all(caseSlug) as unknown as Raw[]
  ).map(toRow)
  let bodies = new Map<number, string>()
  try {
    const md = fs.readFileSync(path.join(caseDir(argusHome, caseSlug), 'findings.md'), 'utf8')
    bodies = parseFindingBodies(md)
  } catch {
    // no findings.md yet (or unreadable) → cards render body-less
  }
  return rows.map((r) => {
    const body = bodies.get(r.id)
    return body ? { ...r, body } : r
  })
}

export function reviewFinding(db: DatabaseSync, id: number, state: ReviewState): FindingRow | null {
  if (!REVIEW_STATES.includes(state))
    throw new Error(`Invalid review state: ${JSON.stringify(state)}`)
  const reviewedAt = state === 'pending' ? null : new Date().toISOString()
  db.prepare(`UPDATE findings SET review_state = ?, reviewed_at = ? WHERE id = ?`).run(
    state,
    reviewedAt,
    id
  )
  const row = db
    .prepare(`SELECT f.*, s.mode AS mode FROM ${FINDINGS_WITH_MODE} WHERE f.id = ?`)
    .get(id) as unknown as Raw | undefined
  return row ? toRow(row) : null
}

/** findings.md minus the marker segments for `ids` — mode-scoped clear must leave the other
 *  mode's bodies intact. Everything before the first `<!-- finding:N -->` marker (the seeded
 *  header, any pre-marker prose) is always kept. */
export function removeFindingBodies(md: string, ids: ReadonlySet<number>): string {
  const parts = md.split(/<!-- finding:(\d+) -->/)
  let out = parts[0]
  for (let i = 1; i < parts.length; i += 2) {
    if (ids.has(Number(parts[i]))) continue
    out += `<!-- finding:${parts[i]} -->${parts[i + 1] ?? ''}`
  }
  return out
}

/**
 * Clear findings per case: with no `mode`, delete every row and reset findings.md to the seeded
 * header createCase writes. With a `mode`, delete only findings whose session-derived mode
 * matches (same COALESCE rule as toRow: session-less rows are investigation) and strip only
 * their findings.md sections. Order: DB → audit → filesystem.
 */
export function clearFindings(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  mode?: ModeId
): { cleared: number } {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  const mdPath = path.join(caseDir(argusHome, caseSlug), 'findings.md')
  if (mode === undefined) {
    const res = db.prepare(`DELETE FROM findings WHERE case_id = ?`).run(kase.id)
    const cleared = Number(res.changes)
    appendDeletionAudit(argusHome, 'findings.clear', caseSlug, { cleared })
    fs.writeFileSync(mdPath, `# Findings — ${caseSlug}\n`)
    return { cleared }
  }
  const ids = (
    db
      .prepare(
        `SELECT f.id FROM ${FINDINGS_WITH_MODE}
         WHERE f.case_id = ? AND COALESCE(s.mode, ?) = ?`
      )
      .all(kase.id, DEFAULT_MODE, mode) as { id: number }[]
  ).map((r) => r.id)
  if (ids.length > 0)
    db.prepare(`DELETE FROM findings WHERE id IN (${ids.map(() => '?').join(', ')})`).run(...ids)
  appendDeletionAudit(argusHome, 'findings.clear', caseSlug, { cleared: ids.length, mode })
  try {
    fs.writeFileSync(mdPath, removeFindingBodies(fs.readFileSync(mdPath, 'utf8'), new Set(ids)))
  } catch {
    // no findings.md yet — nothing to strip, and a full-file reset would be wrong here
  }
  return { cleared: ids.length }
}

/**
 * Record the outcome of a write action on a finding. Only the supplied keys are written, so
 * posting a comment never clears a previous push and vice versa. Silently no-ops on an empty
 * patch rather than emitting `SET WHERE id = ?` with no assignments.
 */
export function recordFindingWrite(
  db: DatabaseSync,
  id: number,
  patch: { commentUrl?: string; pushedSha?: string }
): void {
  const sets: string[] = []
  const vals: string[] = []
  if (patch.commentUrl !== undefined) {
    sets.push('comment_url = ?')
    vals.push(patch.commentUrl)
  }
  if (patch.pushedSha !== undefined) {
    sets.push('pushed_sha = ?')
    vals.push(patch.pushedSha)
  }
  if (sets.length === 0) return
  db.prepare(`UPDATE findings SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}
