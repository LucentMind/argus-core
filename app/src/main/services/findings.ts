import type { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { FindingRow, ReviewState } from '../../shared/observability'
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
    createdAt: r.created_at
  }
}

export function listFindings(db: DatabaseSync, caseSlug: string): FindingRow[] {
  const rows = db
    .prepare(
      `SELECT f.* FROM findings f JOIN cases c ON c.id = f.case_id
       WHERE c.slug = ? ORDER BY f.id DESC`
    )
    .all(caseSlug) as unknown as Raw[]
  return rows.map(toRow)
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
  const row = db.prepare(`SELECT * FROM findings WHERE id = ?`).get(id) as unknown as
    Raw | undefined
  return row ? toRow(row) : null
}

/**
 * Clear-all per case: delete every findings row and reset findings.md to the
 * seeded header createCase writes. Order: DB → audit → filesystem.
 */
export function clearFindings(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string
): { cleared: number } {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  const res = db.prepare(`DELETE FROM findings WHERE case_id = ?`).run(kase.id)
  const cleared = Number(res.changes)
  appendDeletionAudit(argusHome, 'findings.clear', caseSlug, { cleared })
  fs.writeFileSync(
    path.join(caseDir(argusHome, caseSlug), 'findings.md'),
    `# Findings — ${caseSlug}\n`
  )
  return { cleared }
}
