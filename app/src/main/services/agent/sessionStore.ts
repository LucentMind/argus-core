import type { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { SessionSummary } from '../../../shared/types'
import { getCase } from '../caseService'
import { caseDir } from '../paths'
import { appendDeletionAudit } from '../deletionAudit'

const TITLE_MAX = 40

function caseIdOf(db: DatabaseSync, caseSlug: string): number {
  const rec = getCase(db, caseSlug)
  if (!rec) throw new Error(`Unknown case: ${caseSlug}`)
  return rec.id
}

function rowToSummary(r: {
  id: number
  title: string
  turn_count: number
  updated_at: string
}): SessionSummary {
  return { id: r.id, title: r.title, turnCount: r.turn_count, updatedAt: r.updated_at }
}

/** `driverKind` is stamped at creation (Task 7 evidence: `driver_kind` gates cursor
 *  reuse — see `sessionCursor` below) so a session's cursor is never handed to the wrong
 *  driver even if the active provider changes later. */
export function createSession(
  db: DatabaseSync,
  caseSlug: string,
  driverKind: string
): SessionSummary {
  const caseId = caseIdOf(db, caseSlug)
  const now = new Date().toISOString()
  const res = db
    .prepare(
      `INSERT INTO sessions (case_id, turn_count, created_at, updated_at, driver_kind) VALUES (?, 0, ?, ?, ?)`
    )
    .run(caseId, now, now, driverKind)
  return { id: Number(res.lastInsertRowid), title: '', turnCount: 0, updatedAt: now }
}

/** Newest-first summaries; guarantees every case has at least one session. `driverKind`
 *  only matters for the (rare) auto-create path — a case with zero sessions — so it
 *  defaults to the Claude driver (matching the sessions.driver_kind column default);
 *  callers with live driver context (e.g. AgentService) may still pass the active kind. */
export function listSessions(
  db: DatabaseSync,
  caseSlug: string,
  driverKind = 'claude-agent-sdk'
): SessionSummary[] {
  const caseId = caseIdOf(db, caseSlug)
  const rows = db
    .prepare(
      `SELECT id, title, turn_count, updated_at FROM sessions WHERE case_id = ? ORDER BY updated_at DESC, id DESC`
    )
    .all(caseId) as never[]
  if (rows.length === 0) return [createSession(db, caseSlug, driverKind)]
  return (rows as { id: number; title: string; turn_count: number; updated_at: string }[]).map(
    rowToSummary
  )
}

export function renameSession(db: DatabaseSync, sessionId: number, title: string): void {
  db.prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`).run(
    title.trim().slice(0, TITLE_MAX),
    new Date().toISOString(),
    sessionId
  )
}

/** First-user-message default title: set once, never overwrite a non-empty title. */
export function setTitleIfEmpty(db: DatabaseSync, sessionId: number, firstMessage: string): void {
  db.prepare(`UPDATE sessions SET title = ? WHERE id = ? AND title = ''`).run(
    firstMessage.trim().slice(0, TITLE_MAX),
    sessionId
  )
}

/** Returns the resume cursor only when it was produced by the same driver kind —
 *  a Claude session's cursor must never be handed to a Copilot driver and vice versa. */
export function sessionCursor(
  db: DatabaseSync,
  sessionId: number,
  driverKind: string
): string | null {
  const row = db
    .prepare(`SELECT driver_cursor, driver_kind FROM sessions WHERE id = ?`)
    .get(sessionId) as { driver_cursor: string | null; driver_kind: string } | undefined
  if (!row || row.driver_kind !== driverKind) return null
  return row.driver_cursor
}

export function touchSession(db: DatabaseSync, sessionId: number): void {
  db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    sessionId
  )
}

/**
 * Hard-delete one chat: turns/tool_calls/messages_fts rows (session_id has no
 * FK — manual cleanup), the sessions row, then the transcript mirror JSONL.
 * The caller must stop any live CaseSession first (AgentService.stopSession) —
 * deleting under a live mirror stream corrupts state. If this was the case's
 * last session, listSessions auto-creates a fresh one on the next call.
 */
export function deleteSession(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  sessionId: number
): void {
  if (!Number.isInteger(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  const caseId = caseIdOf(db, caseSlug)
  const row = db
    .prepare(`SELECT case_id, title, turn_count FROM sessions WHERE id = ?`)
    .get(sessionId) as { case_id: number; title: string; turn_count: number } | undefined
  if (!row || row.case_id !== caseId) {
    throw new Error(`Unknown session ${sessionId} for case ${caseSlug}`)
  }
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM messages_fts WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM tool_calls WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM turns WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  appendDeletionAudit(argusHome, 'session.delete', caseSlug, {
    sessionId,
    title: row.title,
    turnCount: row.turn_count
  })
  fs.rmSync(path.join(caseDir(argusHome, caseSlug), 'sessions', `${sessionId}.jsonl`), {
    force: true
  })
}
