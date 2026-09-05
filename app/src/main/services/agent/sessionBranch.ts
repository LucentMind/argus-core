import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentDriver } from './driver'
import type { Branching, RewindPreview, RewindResult } from '../../../shared/branching'
import { REWIND_REVIEW_REASON, TURN_STATUS_REWOUND } from '../../../shared/branching'
import type { SessionSummary } from '../../../shared/types'
import type { AgentEvent } from '../../../shared/agent-events'
import { caseDir } from '../paths'
import { assertCaseWritable } from '../caseFreeze'
import { retractFinding } from '../findings'
import { readSessionEvents, copySessionMirror } from './mirror'
import { liveTurnIds } from './liveTurns'
import { sessionSummary, TITLE_MAX } from './sessionStore'

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
/** Appended to a fork's title (spec §5). Never truncated away — see `forkCaseSession`. */
const FORK_SUFFIX = ' (fork)'

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

/** One turn's prompt, from an already-loaded event list — callers hoist the (whole-file)
 *  `readSessionEvents` read out of any per-turn loop; this never re-reads the mirror. */
function promptFrom(events: AgentEvent[], turnId: number): string {
  const e = events.find((x) => x.turnId === turnId && x.type === 'turn.started')
  return e && e.type === 'turn.started' ? e.payload.userText : ''
}

/**
 * One "does this session branch through the provider itself" predicate, shared by the preview
 * and both write paths (rewind, fork) so none of them can compute a different answer from the
 * others. All three provider hooks are required together, not just the one the caller happens
 * to use next: a driver that only implements some of `previewRewind`/`rewindTo`/`forkAt` is not
 * safely "native" for any of them, and checking only the hook in play would let the preview
 * promise a native rewind that the write path (missing `rewindTo`) could never actually perform.
 */
function nativeBranching(driver: AgentDriver, session: SessionRow, anchorRow: TurnRow): boolean {
  return (
    driver.capabilities.branching === 'native' &&
    !!driver.previewRewind &&
    !!driver.rewindTo &&
    !!driver.forkAt &&
    !!session.driver_cursor &&
    !!anchorRow.provider_anchor_id
  )
}

/**
 * What branching a branch AT THIS ANCHOR would actually get — the one question the renderer
 * cannot answer for itself.
 *
 * `capabilitiesFor(settings, instanceId).branching` is a DRIVER fact; `nativeBranching` is an
 * ANCHOR fact, and they disagree routinely: the capability says 'digest' while settings are
 * still loading or when `instanceId` is null, and 'native' on a Claude turn that carries no
 * `provider_anchor_id` — which is every inherited turn of a fork (V2) and every turn surviving
 * a native rewind (V14). Deriving the fork dialog's promise and the permanent divider's wording
 * from the capability let both state the opposite of what happened.
 *
 * Read-only and cheap: preflight plus the predicate, no driver round trip (that is
 * `rewindPreview`'s dry run) and no eviction. Preflight runs under the FORK rules — the last
 * live turn is a legal fork anchor even though it is not a legal rewind anchor — so the same
 * call serves the fork dialog; a rewind's own preview already reports `branching` itself.
 */
export async function branchPreview(
  deps: BranchDeps,
  caseSlug: string,
  sessionId: number,
  anchorTurnId: number
): Promise<{ branching: Branching }> {
  const { session, anchorRow } = preflight(deps, caseSlug, sessionId, anchorTurnId, 'fork')
  const driver = deps.driverFor(sessionId)
  return { branching: nativeBranching(driver, session, anchorRow) ? 'native' : 'digest' }
}

interface TailFindingRow {
  id: number
  summary: string
  review_state: string
  review_actor: string | null
}

/**
 * Which of a rewound tail's findings the rewind actually retracts: the PENDING ones, and only
 * those. One predicate, used by the preview and by the transaction, so the dialog cannot list a
 * finding under "stays as it is" while the write retracts it.
 *
 * M5: this used to also re-retract findings the AGENT had rejected. That overwrote a judgement
 * the agent made ("not a real problem") with one the user never made ("rewound") — and
 * `distill/input.ts` drops `review_reason = REWIND_REVIEW_REASON` findings from the
 * rejected-finding learning signal precisely because a rewind is not a judgement (spec §7.1),
 * so a genuine agent rejection was silently erased from what distillation learns from. A
 * finding that is already rejected is already out of the case's conclusions; there is nothing
 * for a rewind to do to it, whoever rejected it.
 */
const toRetract = (f: { review_state: string }): boolean => f.review_state === 'pending'

interface RewindPlan {
  session: SessionRow
  anchorRow: TurnRow
  tail: TurnRow[]
  native: boolean
  findings: TailFindingRow[]
  calls: { tool: string; count: number }[]
}

/**
 * Everything a rewind at this anchor knows from the DATABASE alone: preflight, the tail, its
 * findings and tool calls, and whether the provider will branch this natively.
 *
 * Split out because `rewindSession` used to call `rewindPreview` a second time "to
 * re-validate" and then discard most of its result. On Claude that is not a database read —
 * `rewindPreview` runs the driver's dry run, so the write path was spending a second
 * `getSessionMessages` and starting a second CLI child, against a session that at that moment
 * was still warm. The dry run belongs to the dialog; re-validation is what preflight (here) and
 * the in-transaction `isTurnActive` re-check do.
 */
function rewindPlan(
  deps: BranchDeps,
  caseSlug: string,
  sessionId: number,
  anchorTurnId: number
): RewindPlan {
  const { session, anchorRow, tail } = preflight(deps, caseSlug, sessionId, anchorTurnId, 'rewind')
  const tailIds = tail.map((t) => t.id)
  const marks = tailIds.map(() => '?').join(',')
  const findings = deps.db
    .prepare(
      `SELECT id, summary, review_state, review_actor FROM findings WHERE session_id = ? AND turn_id IN (${marks}) ORDER BY id`
    )
    .all(sessionId, ...tailIds) as unknown as TailFindingRow[]
  const calls = deps.db
    .prepare(
      `SELECT tool, COUNT(*) AS count FROM tool_calls WHERE session_id = ? AND turn_id IN (${marks})
          AND decision NOT IN ('denied', 'cancelled') GROUP BY tool ORDER BY tool`
    )
    .all(sessionId, ...tailIds) as { tool: string; count: number }[]
  return {
    session,
    anchorRow,
    tail,
    native: nativeBranching(deps.driverFor(sessionId), session, anchorRow),
    findings,
    calls
  }
}

export async function rewindPreview(
  deps: BranchDeps,
  caseSlug: string,
  sessionId: number,
  anchorTurnId: number
): Promise<RewindPreview> {
  const { session, anchorRow, tail, native, findings, calls } = rewindPlan(
    deps,
    caseSlug,
    sessionId,
    anchorTurnId
  )
  const driver = deps.driverFor(sessionId)
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
  // one mirror read for the whole tail, not one per turn (M3/M4).
  const events = tail.length ? readSessionEvents(caseDir(deps.argusHome, caseSlug), sessionId) : []
  return {
    anchorTurnId,
    branching: native ? 'native' : 'digest',
    tail: tail.map((t) => ({
      turnId: t.id,
      userText: promptFrom(events, t.id)
    })),
    findingsToRetract: findings.filter(toRetract).map((f) => ({ id: f.id, summary: f.summary })),
    findingsStaying: findings
      .filter((f) => !toRetract(f))
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

/**
 * `opts.filesUnavailable` — the renderer reporting that the preview THE USER CONFIRMED came
 * back with `files.error` (no checkpoints for this session, or the anchor is not in the
 * provider's transcript). The rewind then proceeds as a conversation-only branch: `forkAt`
 * instead of `rewindTo`, same slice of the provider transcript, no file rewind attempted.
 *
 * It arrives as an argument rather than being re-derived here because this path deliberately no
 * longer runs the driver's dry run (I4) — and re-deriving it would mean the write path could
 * decide something different from the dialog the user actually agreed to.
 */
export function rewindSession(
  deps: BranchDeps,
  caseSlug: string,
  sessionId: number,
  anchorTurnId: number,
  opts?: { filesUnavailable?: boolean }
): Promise<RewindResult> {
  return withBranchLock(sessionId, async () => {
    // Preflight + the tail/findings/tool-call reads, from the DATABASE only. No second
    // `rewindPreview`: that would re-run the driver's dry run against a still-warm session (I4).
    const { session, anchorRow, native } = rewindPlan(deps, caseSlug, sessionId, anchorTurnId)
    const driver = deps.driverFor(sessionId)
    const now = deps.now?.() ?? new Date().toISOString()
    // 1. evict the warm session (flushes the mirror; nothing appends during the write below)
    await deps.evictLive(caseSlug, sessionId)
    // 2. the only irreversible external step — BEFORE any write.
    let newCursor: string | null = null
    if (native) {
      const args = {
        cursor: session.driver_cursor!,
        anchor: anchorRow.provider_anchor_id!,
        caseDir: caseDir(deps.argusHome, caseSlug),
        cliPath: deps.cliPathFor(sessionId)
      }
      // M4: `rewindTo` would fail on precisely the condition the preview already reported, and
      // the user confirmed a dialog that said so. `forkAt` gives the same conversation branch
      // without the file rewind — a degraded rewind rather than a refused one.
      newCursor = opts?.filesUnavailable ? await driver.forkAt!(args) : await driver.rewindTo!(args)
    }
    // 3. re-validate right before the write: `evictLive` and the driver round trip above spend
    //    real time (seconds), long enough for a `send` to land in that window. `isTurnActive`
    //    must be checked again — a stale "not active" from step 0 would let this proceed under
    //    a turn that only started running just now.
    if (deps.isTurnActive(caseSlug, sessionId))
      throw new Error(
        'A turn is still running in this chat. Stop it or wait for it to finish first.'
      )
    // 4. one transaction. The tail is RE-READ here, not reused from preflight/preview: a `send`
    //    landing in the same window would insert a turn with id > anchorTurnId that the earlier,
    //    now-stale `tail` never saw, and it must be marked rewound (and its findings retracted)
    //    exactly like every other turn past the anchor (spec §4.1).
    const db = deps.db
    let tail: TurnRow[] = []
    const retractedIds: number[] = []
    db.exec('BEGIN')
    try {
      tail = liveTurnRows(db, sessionId).filter((t) => t.id > anchorTurnId)
      const tailIds = tail.map((t) => t.id)
      const marks = tailIds.map(() => '?').join(',')
      const findings = tailIds.length
        ? (db
            .prepare(
              `SELECT id, review_state FROM findings WHERE session_id = ? AND turn_id IN (${marks})`
            )
            .all(sessionId, ...tailIds) as unknown as { id: number; review_state: string }[])
        : []
      // The same predicate the preview showed the user — see `toRetract`'s docblock (M5).
      const retracting = findings.filter(toRetract)
      const mark = db.prepare(
        `UPDATE turns SET status = ?, rewound_at = ?, rewound_to_turn_id = ? WHERE id = ?`
      )
      for (const t of tail) mark.run(TURN_STATUS_REWOUND, now, anchorTurnId, t.id)
      // A native rewind replaces this session's cursor with a FORK of the provider session, and
      // the SDK remaps every message uuid across a fork — the same fact deviation V2 records for
      // a fork's inherited turns. So every turn that SURVIVES this rewind carries an anchor that
      // names nothing in the session it now belongs to. Found live 2026-09-05
      // (`scripts/cdp-session-branch.mjs`): after a rewind, "Fork from here" on the anchor turn
      // failed with `Message <anchor> not found in session <new cursor>` — a hard error, not a
      // degraded path. Forget them here, so a later branch at one of those turns takes the
      // digest route (`nativeBranching` requires a non-null anchor) instead.
      //
      // Runs AFTER the mark loop so the rewound tail is already excluded by status: those ids
      // stay valid in `pre_rewind_cursor`, which the statement below preserves, and preflight
      // refuses a rewound turn as an anchor regardless. Guarded on `newCursor` because a digest
      // rewind forks nothing and invalidates nothing.
      if (newCursor) {
        db.prepare(
          `UPDATE turns SET provider_anchor_id = NULL WHERE session_id = ? AND status != ?`
        ).run(sessionId, TURN_STATUS_REWOUND)
      }
      for (const f of retracting) {
        // Only findings `retractFinding` actually changed get broadcast: a `changed: false`
        // result (the row was already in this state) must not fire a spurious update. Belt and
        // braces with `toRetract` above, which no longer selects anything already rejected.
        const r = retractFinding(db, f.id, REWIND_REVIEW_REASON, { actor: 'human' })
        if (r.ok && r.changed) retractedIds.push(f.id)
      }
      db.prepare(
        `UPDATE sessions SET pre_rewind_cursor = driver_cursor, driver_cursor = ?, updated_at = ? WHERE id = ?`
      ).run(newCursor, now, sessionId)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    // 4b. Evict AGAIN, now that the row carries the new cursor. `evictLive` at step 1 only
    //     closed the door for an instant: the driver round trip above takes real seconds, and a
    //     `send` that both STARTS and COMPLETES inside it re-warms a `CaseSession` built from
    //     the pre-rewind cursor. `registry.ts`'s reuse check keys on case+session+mode and
    //     never compares cursors, so that warm object would be handed back to the next send and
    //     would go on talking to the conversation this rewind just branched away from — with no
    //     error anywhere. Awaited before the broadcasts so the renderer's reload cannot race a
    //     session that is still being torn down.
    await deps.evictLive(caseSlug, sessionId)
    // 5. broadcasts
    for (const id of retractedIds)
      deps.emitFindingUpdated({ caseId: session.case_id, caseSlug, sessionId }, id)
    deps.sessionsChanged(caseSlug)
    // 6. the composer prefill: read the mirror ONCE, AFTER evictLive's flush (M3), from the
    //    freshly re-read tail above — not the pre-eviction `preview.tail`.
    const events = tail.length
      ? readSessionEvents(caseDir(deps.argusHome, caseSlug), sessionId)
      : []
    return { composerText: tail[0] ? promptFrom(events, tail[0].id) : '' }
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
    const native = nativeBranching(driver, session, anchorRow)
    let cursor: string | null = null
    if (native) {
      cursor = await driver.forkAt!({
        cursor: session.driver_cursor!,
        anchor: anchorRow.provider_anchor_id!,
        caseDir: caseDir(deps.argusHome, caseSlug),
        cliPath: deps.cliPathFor(sessionId)
      })
    }
    // Re-validate right before the write, same reasoning as rewindSession: evictLive and the
    // (possibly slow) forkAt round trip above are two awaits a `send` can land inside.
    if (deps.isTurnActive(caseSlug, sessionId))
      throw new Error(
        'A turn is still running in this chat. Stop it or wait for it to finish first.'
      )
    const db = deps.db
    let newId = 0
    let inherited: TurnRow[] = []
    db.exec('BEGIN')
    try {
      // Re-read the live set here, inside the transaction and after both awaits, rather than
      // reusing a copy taken before them (spec §4.1) — the same reasoning as rewindSession's
      // tail re-read, kept symmetric even though (unlike the tail) a race turn's id is always
      // greater than anchorTurnId and so can never change what this filter selects.
      inherited = liveTurnRows(db, sessionId).filter((t) => t.id <= anchorTurnId)
      // The suffix is the only thing that tells a fork apart from its parent in the chat
      // switcher, so the BASE gives way to the cap, never the marker. Truncating the joined
      // string instead sliced " (fork)" straight back off for every AUTO-titled chat —
      // `setTitleIfEmpty` cuts a first message to exactly TITLE_MAX — leaving two identically
      // named rows in the switcher. Found live 2026-09-05 (`scripts/cdp-session-branch.mjs`).
      const base = session.title.trim() || 'Chat'
      const title =
        base.length + FORK_SUFFIX.length <= TITLE_MAX
          ? base + FORK_SUFFIX
          : base.slice(0, TITLE_MAX - FORK_SUFFIX.length).trimEnd() + FORK_SUFFIX
      newId = Number(
        db
          .prepare(
            `INSERT INTO sessions (case_id, driver_cursor, driver_kind, instance_id, model, title, turn_count, created_at, updated_at,
                               mode, run_options, permission_mode, forked_from_session_id, forked_at_turn_id, forked_inherited_turns,
                               forked_branching)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            session.case_id,
            cursor,
            session.driver_kind,
            session.instance_id,
            session.model,
            title,
            inherited.length,
            now,
            now,
            session.mode,
            session.run_options,
            session.permission_mode,
            sessionId,
            anchorTurnId,
            inherited.length,
            // What this fork ACTUALLY got, from the one fact that decides it: a cursor came
            // back from the provider, or it did not. Recorded rather than recomputed at render
            // time — the anchor's provider id can be cleared afterwards (V14) and archive
            // restore never puts the cursors back, yet the divider quoting this is permanent.
            cursor !== null ? 'native' : 'digest'
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
      // M1: a rolled-back COMMIT still leaves `copySessionMirror`'s write on disk (it happens
      // before COMMIT, and is not itself transactional — it's a filesystem write, not a SQL
      // one). AUTOINCREMENT's sequence reverts on rollback, so the very next session created —
      // fork or otherwise — reuses this same rowid, and a plain new chat's mirror APPENDS
      // (`SessionMirror.append`/`flush`) rather than overwriting: without this cleanup it would
      // silently inherit this failed fork's transcript as its own opening lines.
      if (newId) {
        fs.rmSync(path.join(caseDir(deps.argusHome, caseSlug), 'sessions', `${newId}.jsonl`), {
          force: true
        })
      }
      throw err
    }
    // Same reasoning as rewindSession's second eviction (I2): the parent's mirror is COPIED
    // inside the transaction above, and a session re-warmed during the `forkAt` round trip is
    // appending to the very file that copy read. Evict once more now the write has landed.
    await deps.evictLive(caseSlug, sessionId)
    deps.sessionsChanged(caseSlug)
    // Important 1: `sessionSummary`/`rowToSummary` hard-code `historyOrphaned: false` — that
    // predicate needs `driverForSession` (reviewFraming.ts), which this DB-only module never
    // has. But the fork already knows both facts this path needs directly: no native cursor
    // (`cursor === null`) with turns actually carried over means the child shows history with
    // nothing to resume it from — precisely `sessionHistoryOrphaned`'s definition, computed
    // here instead of through that driver-aware layer.
    return {
      ...sessionSummary(db, newId)!,
      historyOrphaned: cursor === null && inherited.length > 0
    }
  })
}
