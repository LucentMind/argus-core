import type { DatabaseSync } from 'node:sqlite'
import type { FindingRow, ReviewState } from '../../shared/observability'

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
  if (!REVIEW_STATES.includes(state)) throw new Error(`Invalid review state: ${JSON.stringify(state)}`)
  const reviewedAt = state === 'pending' ? null : new Date().toISOString()
  db.prepare(`UPDATE findings SET review_state = ?, reviewed_at = ? WHERE id = ?`).run(state, reviewedAt, id)
  const row = db.prepare(`SELECT * FROM findings WHERE id = ?`).get(id) as unknown as Raw | undefined
  return row ? toRow(row) : null
}
