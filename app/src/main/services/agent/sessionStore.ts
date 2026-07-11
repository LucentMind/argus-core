import type { DatabaseSync } from 'node:sqlite'
import type { SessionSummary } from '../../../shared/types'
import { getCase } from '../caseService'

const TITLE_MAX = 40

function caseIdOf(db: DatabaseSync, caseSlug: string): number {
  const rec = getCase(db, caseSlug)
  if (!rec) throw new Error(`Unknown case: ${caseSlug}`)
  return rec.id
}

function rowToSummary(r: { id: number; title: string; turn_count: number; updated_at: string }): SessionSummary {
  return { id: r.id, title: r.title, turnCount: r.turn_count, updatedAt: r.updated_at }
}

export function createSession(db: DatabaseSync, caseSlug: string): SessionSummary {
  const caseId = caseIdOf(db, caseSlug)
  const now = new Date().toISOString()
  const res = db
    .prepare(`INSERT INTO sessions (case_id, turn_count, created_at, updated_at) VALUES (?, 0, ?, ?)`)
    .run(caseId, now, now)
  return { id: Number(res.lastInsertRowid), title: '', turnCount: 0, updatedAt: now }
}

/** Newest-first summaries; guarantees every case has at least one session. */
export function listSessions(db: DatabaseSync, caseSlug: string): SessionSummary[] {
  const caseId = caseIdOf(db, caseSlug)
  const rows = db
    .prepare(`SELECT id, title, turn_count, updated_at FROM sessions WHERE case_id = ? ORDER BY updated_at DESC, id DESC`)
    .all(caseId) as never[]
  if (rows.length === 0) return [createSession(db, caseSlug)]
  return (rows as { id: number; title: string; turn_count: number; updated_at: string }[]).map(rowToSummary)
}

export function renameSession(db: DatabaseSync, sessionId: number, title: string): void {
  db.prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title.trim().slice(0, TITLE_MAX), new Date().toISOString(), sessionId)
}

/** First-user-message default title: set once, never overwrite a non-empty title. */
export function setTitleIfEmpty(db: DatabaseSync, sessionId: number, firstMessage: string): void {
  db.prepare(`UPDATE sessions SET title = ? WHERE id = ? AND title = ''`)
    .run(firstMessage.trim().slice(0, TITLE_MAX), sessionId)
}

export function sessionCursor(db: DatabaseSync, sessionId: number): string | null {
  const row = db.prepare(`SELECT sdk_session_id FROM sessions WHERE id = ?`).get(sessionId) as
    { sdk_session_id: string | null } | undefined
  return row?.sdk_session_id ?? null
}

export function touchSession(db: DatabaseSync, sessionId: number): void {
  db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), sessionId)
}
