import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { AgentService } from '../../agent/registry'
import { createSession } from '../../agent/sessionStore'
import { createDetection } from '../../packs/detection'
import { AsyncQueue } from '../../agent/asyncQueue'
import {
  insertRoutineRun,
  attachRunSession,
  finishRoutineRun,
  runningRoutineForSession
} from '../runs'
import { defaultAgentAccess } from '../../../../shared/agentAccess'
import type { CreateQueryFn } from '../../agent/drivers/claude'
import type { AgentEvent } from '../../../../shared/agent-events'

/**
 * REVIEW FIX 5 — a routine's own session row must not accept a second, fully-permissioned
 * session while the run is in flight.
 *
 * The hazard is cross-module and neither side can see it alone: `AgentService` keys its live
 * map by case+session and a background session never enters that map, while index.ts
 * deliberately streams the routine's transcript into the normal case UI so the `routine-x` case
 * IS openable mid-run and the session picker DOES select the routine's session. Typing there
 * reaches `AgentService.send`, misses the map, and builds a SECOND `CaseSession` on the same
 * `sessionId` — this one without `unattended`, with connectors composed, resuming from the same
 * cursor, writing the same `sessions/<id>.jsonl` mirror and the same `turns`/`tool_calls` rows.
 * Worse, when the routine finished, its `stop()` would emit `session.exited` for that sessionId
 * and tear the user's live chat down under them.
 *
 * `sessionUnavailable` is bound here EXACTLY as index.ts binds it, so this exercises the real
 * predicate (`runningRoutineForSession`) against the real guard, not a stand-in for either.
 */

let tmp: string, argusHome: string, db: DatabaseSync, events: AgentEvent[]
const detection = createDetection()

const SLUG = 'routine-x'

function fakeCreateQuery(): { createQuery: CreateQueryFn; built: number } {
  const state = { built: 0 }
  const createQuery: CreateQueryFn = (args) => {
    const options = args.options as Record<string, unknown>
    if (options.systemPrompt) state.built++
    const q = new AsyncQueue<unknown>()
    return Object.assign(
      { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
      { interrupt: async () => q.end() }
    )
  }
  return {
    createQuery,
    get built() {
      return state.built
    }
  }
}

function mkService(sdk: { createQuery: CreateQueryFn }): AgentService {
  return new AgentService({
    db,
    argusHome,
    detection,
    skillsRoots: [],
    agentAccess: () => defaultAgentAccess(),
    onEvent: (e) => events.push(e),
    createQuery: sdk.createQuery,
    // Verbatim from index.ts.
    sessionUnavailable: (sessionId) => {
      const routineId = runningRoutineForSession(db, sessionId)
      return routineId
        ? `This chat is running the routine "${routineId}" unattended right now. Wait for the run to finish before sending a message.`
        : null
    }
  })
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rguard-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  events = []
  createCase(db, argusHome, { slug: SLUG, title: 'Routine: x' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a running routine owns its session row', () => {
  it('refuses a send into the session a routine is currently running', async () => {
    const sdk = fakeCreateQuery()
    const svc = mkService(sdk)
    const session = createSession(db, SLUG, 'claude-agent-sdk')
    const runId = insertRoutineRun(db, 'x', SLUG)
    attachRunSession(db, runId, session.id)

    await expect(svc.send(SLUG, session.id, 'hello')).rejects.toThrow(
      /running the routine "x" unattended/
    )
    // The point is not the message — it is that NO second session was constructed. A silent
    // no-op would be just as wrong in the other direction: the user would see their message
    // vanish with no explanation.
    expect(sdk.built).toBe(0)
    expect(svc.states()).toEqual([])
    await svc.stopAll()
  })

  it('lets the same session through the moment the run finishes', async () => {
    const sdk = fakeCreateQuery()
    const svc = mkService(sdk)
    const session = createSession(db, SLUG, 'claude-agent-sdk')
    const runId = insertRoutineRun(db, 'x', SLUG)
    attachRunSession(db, runId, session.id)
    await expect(svc.send(SLUG, session.id, 'hello')).rejects.toThrow()

    finishRoutineRun(db, runId, { status: 'ok', summary: 'swept' })

    // The guard is a lock for the duration of a run, not a permanent seizure of the row: the
    // routine case is meant to be readable and continuable afterwards.
    await svc.send(SLUG, session.id, 'hello again')
    expect(sdk.built).toBe(1)
    expect(svc.states()).toHaveLength(1)
    await svc.stopAll()
  })

  it('never blocks an ordinary chat', async () => {
    const sdk = fakeCreateQuery()
    const svc = mkService(sdk)
    createCase(db, argusHome, { slug: 'NAV-1', title: 'NAV-1' })
    const routineSession = createSession(db, SLUG, 'claude-agent-sdk')
    const userSession = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const runId = insertRoutineRun(db, 'x', SLUG)
    attachRunSession(db, runId, routineSession.id)

    // A run in flight must lock exactly one session row, not the app.
    await svc.send('NAV-1', userSession.id, 'unrelated work')
    expect(svc.states()).toHaveLength(1)
    await svc.stopAll()
  })

  it('still reports the more specific error for a session that is not the case’s', async () => {
    // Ordering check: the ownership validation must stay ahead of the routine guard, or a
    // mistyped session id would be explained as "a routine is running" instead of as the bad
    // request it is.
    const sdk = fakeCreateQuery()
    const svc = mkService(sdk)
    createCase(db, argusHome, { slug: 'NAV-1', title: 'NAV-1' })
    const routineSession = createSession(db, SLUG, 'claude-agent-sdk')
    const runId = insertRoutineRun(db, 'x', SLUG)
    attachRunSession(db, runId, routineSession.id)

    await expect(svc.send('NAV-1', routineSession.id, 'hi')).rejects.toThrow(
      /Unknown session .* for case NAV-1/
    )
    await svc.stopAll()
  })
})
