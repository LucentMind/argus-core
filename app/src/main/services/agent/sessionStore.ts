import type { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { SessionSummary } from '../../../shared/types'
import { DEFAULT_MODE, MODES, type ModeId } from '../../../shared/modes'
import { caseDir } from '../paths'
import { appendDeletionAudit } from '../deletionAudit'
import { deleteMessagesFtsForSession } from '../ftsIndex'
import type { RunOptionSelection } from '../../../shared/runOptions'
import { PERMISSION_MODES, type PermissionMode } from '../../../shared/settings'

const TITLE_MAX = 40

// A raw id lookup rather than caseService's getCase (which returns the full CaseRecord):
// this module only ever needs the numeric id, and caseService imports createSession /
// latestSessionForMode from here, so resolving through getCase would make the two
// modules import each other for no reason beyond convenience.
function caseIdOf(db: DatabaseSync, caseSlug: string): number {
  const row = db.prepare(`SELECT id FROM cases WHERE slug = ?`).get(caseSlug) as
    { id: number } | undefined
  if (!row) throw new Error(`Unknown case: ${caseSlug}`)
  return row.id
}

interface SessionRow {
  id: number
  title: string
  turn_count: number
  updated_at: string
  driver_kind: string
  instance_id: string | null
  model: string | null
  mode: string
  run_options: string | null
  permission_mode: string | null
}

const SESSION_COLS = `id, title, turn_count, updated_at, driver_kind, instance_id, model, mode, run_options, permission_mode`

function rowToSummary(r: SessionRow): SessionSummary {
  return {
    id: r.id,
    title: r.title,
    turnCount: r.turn_count,
    updatedAt: r.updated_at,
    driverKind: r.driver_kind,
    instanceId: r.instance_id,
    model: r.model,
    mode: r.mode as ModeId,
    runOptions: parseRunOptions(r.run_options),
    permissionMode: parsePermissionMode(r.permission_mode)
  }
}

/** What a new session runs on. Both optional: omitting them reproduces the pre-multi-provider
 *  behaviour of resolving the provider and model from settings at send time. `mode` pins the
 *  session to the mode axis (Task 1's `ModeId`) — a review is a session pinned to 'review'. */
export interface SessionProvider {
  driverKind: string
  instanceId?: string | null
  model?: string | null
  mode?: ModeId
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
      `INSERT INTO sessions (case_id, turn_count, created_at, updated_at, driver_kind, instance_id, model, mode) VALUES (?, 0, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      caseId,
      now,
      now,
      p.driverKind,
      p.instanceId ?? null,
      p.model ?? null,
      p.mode ?? DEFAULT_MODE
    )
  return {
    id: Number(res.lastInsertRowid),
    title: '',
    turnCount: 0,
    updatedAt: now,
    driverKind: p.driverKind,
    instanceId: p.instanceId ?? null,
    model: p.model ?? null,
    mode: p.mode ?? DEFAULT_MODE,
    runOptions: [],
    permissionMode: null
  }
}

/** Newest-first summaries; guarantees every case has at least one session. The provider
 *  only matters for the (rare) auto-create path — a case with zero sessions — so it
 *  defaults to the Claude driver (matching the sessions.driver_kind column default);
 *  callers with live provider context (e.g. AgentService) may still pass the default one.
 *  `mode` is a separate optional parameter (rather than folded into `provider`) because
 *  this module has no access to the case record (that would reintroduce the very cycle
 *  `caseIdOf` avoids by querying the row directly) — callers that already have the case's
 *  activeMode in scope (e.g. the sessions:list IPC handler) pass it through so an
 *  auto-created chat binds to the case's current mode instead of silently defaulting. */
export function listSessions(
  db: DatabaseSync,
  caseSlug: string,
  provider: string | SessionProvider = 'claude-agent-sdk',
  mode?: ModeId
): SessionSummary[] {
  const caseId = caseIdOf(db, caseSlug)
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLS} FROM sessions WHERE case_id = ? ORDER BY updated_at DESC, id DESC`
    )
    .all(caseId) as never[]
  if (rows.length === 0) {
    const p: SessionProvider = typeof provider === 'string' ? { driverKind: provider } : provider
    return [createSession(db, caseSlug, mode !== undefined ? { ...p, mode } : p)]
  }
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

/** The mode a session is pinned to. Falls back to DEFAULT_MODE for rows that predate the
 *  mode axis (matching the column's DEFAULT), AND for a stored value that isn't a real
 *  MODES key — defence in depth against a direct DB edit or a downgrade from a version
 *  that wrote a mode this build no longer knows, either of which would otherwise make
 *  MODES[mode] undefined and throw on every later send/render. */
export function sessionMode(db: DatabaseSync, sessionId: number): ModeId {
  const row = db.prepare(`SELECT mode FROM sessions WHERE id = ?`).get(sessionId) as
    { mode: string } | undefined
  const mode = row?.mode
  return mode && mode in MODES ? (mode as ModeId) : DEFAULT_MODE
}

/** The most recent session pinned to `mode` (see shared/modes.ts), or null when the case
 *  has none yet. Used by caseService.setCaseMode to find the chat a mode switch should
 *  land on — creating one bound to `mode` only when this returns null, so the other
 *  mode's chats are never touched by a switch. */
export function latestSessionForMode(
  db: DatabaseSync,
  caseSlug: string,
  mode: ModeId
): SessionSummary | null {
  const caseId = caseIdOf(db, caseSlug)
  const row = db
    .prepare(
      `SELECT ${SESSION_COLS} FROM sessions WHERE case_id = ? AND mode = ? ORDER BY updated_at DESC, id DESC LIMIT 1`
    )
    .get(caseId, mode) as SessionRow | undefined
  return row ? rowToSummary(row) : null
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
    deleteMessagesFtsForSession(db, sessionId)
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

/** Tolerant of anything: a hand-edited row or a downgrade must not throw on every render. */
function parseRunOptions(raw: string | null): RunOptionSelection[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is RunOptionSelection =>
        !!s &&
        typeof s === 'object' &&
        typeof (s as RunOptionSelection).id === 'string' &&
        ['string', 'boolean'].includes(typeof (s as RunOptionSelection).value)
    )
  } catch {
    return []
  }
}

function parsePermissionMode(raw: string | null): PermissionMode | null {
  return raw && (PERMISSION_MODES as readonly string[]).includes(raw)
    ? (raw as PermissionMode)
    : null
}

/** This session's stored option selections. Empty means "every default". */
export function sessionRunOptions(db: DatabaseSync, sessionId: number): RunOptionSelection[] {
  const row = db.prepare(`SELECT run_options FROM sessions WHERE id = ?`).get(sessionId) as
    { run_options: string | null } | undefined
  return parseRunOptions(row?.run_options ?? null)
}

/** Sorted by `id` so two selections that differ only in array order compare (and store)
 *  identically — the column is meant to be compared semantically, not as raw text. */
function normalizeRunOptions(sel: readonly RunOptionSelection[]): RunOptionSelection[] {
  return [...sel].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Writes NULL for an empty selection rather than `[]`, so absent-key defaults keep working.
 *  Returns true when the stored value actually changed. Comparison is semantic (sorted by
 *  `id`, via `parseRunOptions`), not raw-string: a reorder, or a row serialised by a different
 *  code path, must not be reported as a change. */
export function setSessionRunOptions(
  db: DatabaseSync,
  sessionId: number,
  sel: readonly RunOptionSelection[]
): boolean {
  const row = db.prepare(`SELECT run_options FROM sessions WHERE id = ?`).get(sessionId) as
    { run_options: string | null } | undefined
  if (!row) return false
  const normalized = normalizeRunOptions(sel)
  const current = normalizeRunOptions(parseRunOptions(row.run_options))
  if (JSON.stringify(current) === JSON.stringify(normalized)) return false
  const next = normalized.length > 0 ? JSON.stringify(normalized) : null
  db.prepare(`UPDATE sessions SET run_options = ? WHERE id = ?`).run(next, sessionId)
  return true
}

/** Null means "fall back to settings.agent.defaultPermissionMode". */
export function sessionPermissionMode(
  db: DatabaseSync,
  sessionId: number
): PermissionMode | null {
  const row = db.prepare(`SELECT permission_mode FROM sessions WHERE id = ?`).get(sessionId) as
    { permission_mode: string | null } | undefined
  return parsePermissionMode(row?.permission_mode ?? null)
}

/** Throws on anything that is not a real PermissionMode. Used at the IPC boundary:
 *  pinning a session to a mode no driver understands would strand the chat. */
export function assertPermissionMode(value: unknown): asserts value is PermissionMode {
  if (typeof value !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(value)) {
    throw new Error(`Invalid permission mode: ${String(value)}`)
  }
}

export function setSessionPermissionMode(
  db: DatabaseSync,
  sessionId: number,
  mode: PermissionMode
): boolean {
  const row = db.prepare(`SELECT permission_mode FROM sessions WHERE id = ?`).get(sessionId) as
    { permission_mode: string | null } | undefined
  if (!row) return false
  const current = parsePermissionMode(row.permission_mode)
  if (current === mode) return false
  db.prepare(`UPDATE sessions SET permission_mode = ? WHERE id = ?`).run(mode, sessionId)
  return true
}
