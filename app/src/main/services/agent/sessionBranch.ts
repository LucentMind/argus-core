import type { DatabaseSync } from 'node:sqlite'
import type { AgentDriver } from './driver'
import type { RewindPreview, RewindResult } from '../../../shared/branching'
import { TURN_STATUS_REWOUND } from '../../../shared/branching'
import type { SessionSummary } from '../../../shared/types'
import { caseDir } from '../paths'
import { assertCaseWritable } from '../caseFreeze'
import { retractFinding } from '../findings'
import { readSessionEvents, copySessionMirror } from './mirror'
import { liveTurnIds } from './liveTurns'
import { sessionSummary } from './sessionStore'

export interface BranchDeps {
  db: DatabaseSync
  argusHome: string
  driverFor: (sessionId: number) => AgentDriver
  cliPathFor: (sessionId: number) => string | undefined
  isTurnActive: (caseSlug: string, sessionId: number) => boolean
  /** Stop + evict the warm session so nothing appends to the mirror mid-operation. */
  evictLive: (caseSlug: string, sessionId: number) => Promise<void>
  emitFindingUpdated: (
    ctx: { caseId: number; caseSlug: string; sessionId: number },
    findingId: number
  ) => void
  sessionsChanged: (caseSlug: string) => void
  now?: () => string
}

/** Tool calls whose effect outlives a rewind (spec §4.2). Listed, never undone. */
export const EXTERNAL_TOOLS: readonly string[] = [
  'mcp__argus__post_review_comment',
  'mcp__argus__push_review_change',
  'mcp__argus__update_case_status',
  'mcp__argus__workspace_checkout',
  'mcp__argus__write_proposal',
  'mcp__argus__write_memory',
  'mcp__argus__ingest_artifact',
  'mcp__argus__panel_ingest_evidence'
]
const isExternal = (tool: string): boolean => EXTERNAL_TOOLS.includes(tool) || /jira/i.test(tool)
export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']

// One in-process lock per session. Non-reentrant on purpose (caseFreeze.ts has the argument).
const busy = new Set<number>()
async function withBranchLock<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
  if (busy.has(sessionId))
    throw new Error('This chat is already being rewound or forked. Wait for that to finish.')
  busy.add(sessionId)
  try {
    return await fn()
  } finally {
    busy.delete(sessionId)
  }
}

interface TurnRow {
  id: number
  status: string
  provider_anchor_id: string | null
}
interface SessionRow {
  id: number
  case_id: number
  driver_cursor: string | null
  driver_kind: string
  instance_id: string | null
  model: string | null
  title: string
  mode: string
  run_options: string | null
  permission_mode: string | null
}

function loadSession(db: DatabaseSync, caseSlug: string, sessionId: number): SessionRow {
  const row = db
    .prepare(
      `SELECT s.id, s.case_id, s.driver_cursor, s.driver_kind, s.instance_id, s.model, s.title, s.mode, s.run_options, s.permission_mode
       FROM sessions s JOIN cases c ON c.id = s.case_id WHERE s.id = ? AND c.slug = ?`
    )
    .get(sessionId, caseSlug) as SessionRow | undefined
  if (!row) throw new Error(`Session ${sessionId} is not a chat of case ${caseSlug}`)
  return row
}

/**
 * The session's live turn rows, oldest first. The live SET is `liveTurnIds`' answer and
 * nothing else — this module never re-states the `status != 'rewound'` predicate, so a
 * change to what "live" means cannot leave rewind/fork reading a different history from
 * the digest builders (spec §7).
 */
function liveTurnRows(db: DatabaseSync, sessionId: number): TurnRow[] {
  const live = liveTurnIds(db, sessionId)
  const rows = db
    .prepare(`SELECT id, status, provider_anchor_id FROM turns WHERE session_id = ? ORDER BY id`)
    .all(sessionId) as unknown as TurnRow[]
  return rows.filter((r) => live.has(r.id))
}

/** Shared preflight (spec §4.1 / §5). Returns the anchor and the live turns after it. */
function preflight(
  deps: BranchDeps,
  caseSlug: string,
  sessionId: number,
  anchorTurnId: number,
  op: 'rewind' | 'fork'
): { session: SessionRow; anchorRow: TurnRow; tail: TurnRow[] } {
  assertCaseWritable(deps.db, caseSlug)
  const session = loadSession(deps.db, caseSlug, sessionId)
  if (deps.isTurnActive(caseSlug, sessionId))
    throw new Error('A turn is still running in this chat. Stop it or wait for it to finish first.')
  const anchorRow = deps.db
    .prepare(`SELECT id, status, provider_anchor_id FROM turns WHERE id = ? AND session_id = ?`)
    .get(anchorTurnId, sessionId) as TurnRow | undefined
  if (!anchorRow) throw new Error(`Turn ${anchorTurnId} is not a turn of this session`)
  if (anchorRow.status === TURN_STATUS_REWOUND)
    throw new Error('That turn was rewound; pick a live turn')
  if (anchorRow.status === 'running') throw new Error('That turn has not finished')
  const tail = liveTurnRows(deps.db, sessionId).filter((t) => t.id > anchorTurnId)
  if (op === 'rewind' && tail.length === 0)
    throw new Error('That reply is already the last one; there is nothing to rewind')
  return { session, anchorRow, tail }
}

function promptOf(deps: BranchDeps, caseSlug: string, sessionId: number, turnId: number): string {
  const e = readSessionEvents(caseDir(deps.argusHome, caseSlug), sessionId).find(
    (x) => x.turnId === turnId && x.type === 'turn.started'
  )
  return e && e.type === 'turn.started' ? e.payload.userText : ''
}

export async function rewindPreview(
  deps: BranchDeps,
  caseSlug: string,
  sessionId: number,
  anchorTurnId: number
): Promise<RewindPreview> {
  const { session, anchorRow, tail } = preflight(deps, caseSlug, sessionId, anchorTurnId, 'rewind')
  const driver = deps.driverFor(sessionId)
  const tailIds = tail.map((t) => t.id)
  const marks = tailIds.map(() => '?').join(',')
  const findings = deps.db
    .prepare(
      `SELECT id, summary, review_state, review_actor FROM findings WHERE session_id = ? AND turn_id IN (${marks}) ORDER BY id`
    )
    .all(sessionId, ...tailIds) as {
    id: number
    summary: string
    review_state: string
    review_actor: string | null
  }[]
  const calls = deps.db
    .prepare(
      `SELECT tool, COUNT(*) AS count FROM tool_calls WHERE session_id = ? AND turn_id IN (${marks})
          AND decision NOT IN ('denied', 'cancelled') GROUP BY tool ORDER BY tool`
    )
    .all(sessionId, ...tailIds) as { tool: string; count: number }[]
  const native =
    driver.capabilities.branching === 'native' &&
    !!driver.previewRewind &&
    !!session.driver_cursor &&
    !!anchorRow.provider_anchor_id
  const files: RewindPreview['files'] = native
    ? {
        kind: 'native',
        // spread, not field-by-field: the driver's optional `error` (no checkpoints, anchor
        // not in the provider transcript) is what the confirm dialog warns on, and picking
        // fields by hand is how it would silently stop reaching the renderer.
        ...(await driver.previewRewind!({
          cursor: session.driver_cursor!,
          anchor: anchorRow.provider_anchor_id!,
          caseDir: caseDir(deps.argusHome, caseSlug),
          cliPath: deps.cliPathFor(sessionId)
        }))
      }
    : { kind: 'counts', writes: calls.filter((c) => WRITE_TOOLS.includes(c.tool)) }
  return {
    anchorTurnId,
    branching: native ? 'native' : 'digest',
    tail: tail.map((t) => ({
      turnId: t.id,
      userText: promptOf(deps, caseSlug, sessionId, t.id)
    })),
    findingsToRetract: findings
      .filter(
        (f) =>
          f.review_state === 'pending' ||
          (f.review_state === 'rejected' && f.review_actor === 'agent')
      )
      .map((f) => ({ id: f.id, summary: f.summary })),
    findingsStaying: findings
      .filter(
        (f) =>
          f.review_state === 'accepted' ||
          (f.review_state === 'rejected' && f.review_actor !== 'agent')
      )
      .map((f) => ({
        id: f.id,
        summary: f.summary,
        reason:
          f.review_state === 'accepted' ? ('accepted' as const) : ('already-retracted' as const)
      })),
    externalActions: calls.filter((c) => isExternal(c.tool)),
    files
  }
}

export function rewindSession(
  deps: BranchDeps,
  caseSlug: string,
  sessionId: number,
  anchorTurnId: number
): Promise<RewindResult> {
  return withBranchLock(sessionId, async () => {
    const { session, anchorRow, tail } = preflight(
      deps,
      caseSlug,
      sessionId,
      anchorTurnId,
      'rewind'
    )
    const preview = await rewindPreview(deps, caseSlug, sessionId, anchorTurnId) // re-validates; also the findings split
    const driver = deps.driverFor(sessionId)
    const now = deps.now?.() ?? new Date().toISOString()
    // 1. evict the warm session (flushes the mirror; nothing appends during the write below)
    await deps.evictLive(caseSlug, sessionId)
    // 2. the only irreversible external step — BEFORE any write. A preview that carried an
    //    `error` is NOT pre-empted here: the driver owns the refusal, and duplicating the
    //    decision on this side is how the two would drift.
    let newCursor: string | null = null
    if (preview.branching === 'native' && driver.rewindTo) {
      newCursor = await driver.rewindTo({
        cursor: session.driver_cursor!,
        anchor: anchorRow.provider_anchor_id!,
        caseDir: caseDir(deps.argusHome, caseSlug),
        cliPath: deps.cliPathFor(sessionId)
      })
    }
    // 3. one transaction
    const db = deps.db
    db.exec('BEGIN')
    try {
      const mark = db.prepare(
        `UPDATE turns SET status = ?, rewound_at = ?, rewound_to_turn_id = ? WHERE id = ?`
      )
      for (const t of tail) mark.run(TURN_STATUS_REWOUND, now, anchorTurnId, t.id)
      for (const f of preview.findingsToRetract)
        retractFinding(db, f.id, 'rewound', { actor: 'human' })
      db.prepare(
        `UPDATE sessions SET pre_rewind_cursor = driver_cursor, driver_cursor = ?, updated_at = ? WHERE id = ?`
      ).run(newCursor, now, sessionId)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    // 4. broadcasts
    for (const f of preview.findingsToRetract)
      deps.emitFindingUpdated({ caseId: session.case_id, caseSlug, sessionId }, f.id)
    deps.sessionsChanged(caseSlug)
    // 5. the composer prefill
    return { composerText: preview.tail[0]?.userText ?? '' }
  })
}

export function forkCaseSession(
  deps: BranchDeps,
  caseSlug: string,
  sessionId: number,
  anchorTurnId: number
): Promise<SessionSummary> {
  return withBranchLock(sessionId, async () => {
    const { session, anchorRow } = preflight(deps, caseSlug, sessionId, anchorTurnId, 'fork')
    const driver = deps.driverFor(sessionId)
    const now = deps.now?.() ?? new Date().toISOString()
    await deps.evictLive(caseSlug, sessionId) // flush the parent's mirror before copying it
    const inherited = liveTurnRows(deps.db, sessionId).filter((t) => t.id <= anchorTurnId)
    let cursor: string | null = null
    if (
      driver.capabilities.branching === 'native' &&
      driver.forkAt &&
      session.driver_cursor &&
      anchorRow.provider_anchor_id
    ) {
      cursor = await driver.forkAt({
        cursor: session.driver_cursor,
        anchor: anchorRow.provider_anchor_id,
        caseDir: caseDir(deps.argusHome, caseSlug),
        cliPath: deps.cliPathFor(sessionId)
      })
    }
    const db = deps.db
    let newId = 0
    db.exec('BEGIN')
    try {
      newId = Number(
        db
          .prepare(
            `INSERT INTO sessions (case_id, driver_cursor, driver_kind, instance_id, model, title, turn_count, created_at, updated_at,
                               mode, run_options, permission_mode, forked_from_session_id, forked_at_turn_id, forked_inherited_turns)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            session.case_id,
            cursor,
            session.driver_kind,
            session.instance_id,
            session.model,
            `${session.title} (fork)`.trim(),
            inherited.length,
            now,
            now,
            session.mode,
            session.run_options,
            session.permission_mode,
            sessionId,
            anchorTurnId,
            inherited.length
          ).lastInsertRowid
      )
      const copy = db.prepare(
        `INSERT INTO turns (case_id, session_id, turn_index, status, input_tokens, output_tokens, cost_usd, duration_ms, created_at, model)
         SELECT case_id, ?, turn_index, status, input_tokens, output_tokens, cost_usd, duration_ms, created_at, model FROM turns WHERE id = ?`
      )
      const map = new Map<number, number>()
      // provider ids deliberately NOT copied (V2): an anchor identifies a message in the
      // PARENT's provider transcript, and the fork's own is a different one.
      for (const t of inherited) map.set(t.id, Number(copy.run(newId, t.id).lastInsertRowid))
      copySessionMirror(caseDir(deps.argusHome, caseSlug), sessionId, newId, map, {
        caseId: session.case_id,
        caseSlug
      })
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    deps.sessionsChanged(caseSlug)
    return sessionSummary(db, newId)!
  })
}
