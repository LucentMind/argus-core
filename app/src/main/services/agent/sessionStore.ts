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

interface SessionRow {
  id: number
  title: string
  turn_count: number
  updated_at: string
  driver_kind: string
  instance_id: string | null
  model: string | null
}

const SESSION_COLS = `id, title, turn_count, updated_at, driver_kind, instance_id, model`

function rowToSummary(r: SessionRow): SessionSummary {
  return {
    id: r.id,
    title: r.title,
    turnCount: r.turn_count,
    updatedAt: r.updated_at,
    driverKind: r.driver_kind,
    instanceId: r.instance_id,
    model: r.model
  }
}

/** What a new session runs on. Both optional: omitting them reproduces the pre-multi-provider
 *  behaviour of resolving the provider and model from settings at send time. */
export interface SessionProvider {
  driverKind: string
  instanceId?: string | null
  model?: string | null
}

/** `driverKind` is stamped at creation (Task 7 evidence: `driver_kind` gates cursor
 *  reuse — see `sessionCursor` below) so a session's cursor is never handed to the wrong
 *  driver even if the active provider changes later. `instanceId` narrows that further:
 *  two instances of the SAME driver kind (two accounts) must not share a cursor either. */
export function createSession(
  db: DatabaseSync,
  caseSlug: string,
  provider: string | SessionProvider
): SessionSummary {
  const p: SessionProvider = typeof provider === 'string' ? { driverKind: provider } : provider
  const caseId = caseIdOf(db, caseSlug)
  const now = new Date().toISOString()
  const res = db
    .prepare(
      `INSERT INTO sessions (case_id, turn_count, created_at, updated_at, driver_kind, instance_id, model) VALUES (?, 0, ?, ?, ?, ?, ?)`
    )
    .run(caseId, now, now, p.driverKind, p.instanceId ?? null, p.model ?? null)
  return {
    id: Number(res.lastInsertRowid),
    title: '',
    turnCount: 0,
    updatedAt: now,
    driverKind: p.driverKind,
    instanceId: p.instanceId ?? null,
    model: p.model ?? null
  }
}

/** Newest-first summaries; guarantees every case has at least one session. The provider
 *  only matters for the (rare) auto-create path — a case with zero sessions — so it
 *  defaults to the Claude driver (matching the sessions.driver_kind column default);
 *  callers with live provider context (e.g. AgentService) may still pass the default one. */
export function listSessions(
  db: DatabaseSync,
  caseSlug: string,
  provider: string | SessionProvider = 'claude-agent-sdk'
): SessionSummary[] {
  const caseId = caseIdOf(db, caseSlug)
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLS} FROM sessions WHERE case_id = ? ORDER BY updated_at DESC, id DESC`
    )
    .all(caseId) as never[]
  if (rows.length === 0) return [createSession(db, caseSlug, provider)]
  return (rows as SessionRow[]).map(rowToSummary)
}

/** The provider/model a session is pinned to, or nulls when it predates multi-provider. */
export function sessionProvider(
  db: DatabaseSync,
  sessionId: number
): { driverKind: string; instanceId: string | null; model: string | null } | null {
  const row = db
    .prepare(`SELECT driver_kind, instance_id, model FROM sessions WHERE id = ?`)
    .get(sessionId) as
    { driver_kind: string; instance_id: string | null; model: string | null } | undefined
  if (!row) return null
  return { driverKind: row.driver_kind, instanceId: row.instance_id, model: row.model }
}

/**
 * Re-pin a session to a provider instance + model. Also re-stamps `driver_kind`, and clears
 * `driver_cursor` when the driver kind changes — a cursor is only meaningful to the driver
 * that produced it, and leaving a stale one would let `sessionCursor`'s guard pass later if
 * the user switched back. Returns true when anything actually changed.
 */
export function setSessionModel(
  db: DatabaseSync,
  sessionId: number,
  provider: SessionProvider
): boolean {
  const current = sessionProvider(db, sessionId)
  if (!current) return false
  const instanceId = provider.instanceId ?? null
  const model = provider.model ?? null
  if (
    current.driverKind === provider.driverKind &&
    current.instanceId === instanceId &&
    current.model === model
  ) {
    return false
  }
  const kindChanged = current.driverKind !== provider.driverKind
  db.prepare(
    `UPDATE sessions SET driver_kind = ?, instance_id = ?, model = ?${kindChanged ? ', driver_cursor = NULL' : ''} WHERE id = ?`
  ).run(provider.driverKind, instanceId, model, sessionId)
  return true
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

/**
 * Returns the resume cursor only when it was produced by the same driver kind — a Claude
 * session's cursor must never be handed to a Copilot driver and vice versa.
 *
 * When an `instanceId` is supplied the guard tightens to the instance: two instances of the
 * same driver kind are two different accounts, and a cursor from one is not resumable by the
 * other. A row with a null `instance_id` predates multi-provider, so it is matched on kind
 * alone rather than being invalidated — that would drop history for every existing session.
 */
export function sessionCursor(
  db: DatabaseSync,
  sessionId: number,
  driverKind: string,
  instanceId?: string | null
): string | null {
  const row = db
    .prepare(`SELECT driver_cursor, driver_kind, instance_id FROM sessions WHERE id = ?`)
    .get(sessionId) as
    { driver_cursor: string | null; driver_kind: string; instance_id: string | null } | undefined
  if (!row || row.driver_kind !== driverKind) return null
  if (instanceId && row.instance_id && row.instance_id !== instanceId) return null
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
