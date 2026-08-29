import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { AgentService } from '../registry'
import { createSession } from '../sessionStore'
import { SessionMirror } from '../mirror'
import { AsyncQueue } from '../asyncQueue'
import { freezeCase } from '../../caseFreeze'
import { caseDir } from '../../paths'
import { createDetection } from '../../packs/detection'
import { createImmediateQueue } from '../../ingestQueue'
import { defaultAgentAccess } from '../../../../shared/agentAccess'
import type { CreateQueryFn } from '../drivers/claude'
import type { AgentEvent } from '../../../../shared/agent-events'

/**
 * WHOLE-BRANCH FINDING C1 — the archive freeze must stop a WARM chat session, not only a
 * session being created or a mirror being constructed.
 *
 * The state no test in this repo constructed before: a session that has ALREADY sent once and
 * finished its turn, is still in `AgentService`'s live map (there is no idle timer — entries
 * leave only on an explicit stop, a driver exit or the LRU reap), and is sent to a SECOND time
 * while the case is frozen. `getOrCreate` hands that session straight back at `return existing`,
 * so `mirrorFactory` — and with it `SessionMirror`'s `assertCaseWritable` — is never reached
 * again. Seven per-task reviews and 23 mutations missed it because every existing freeze test
 * constructs something: a session (`createSession`), or a mirror (`new SessionMirror`). None of
 * them sends twice.
 *
 * The consequence is silent, unrecoverable loss on the feature's own happy path: finish a turn,
 * click Archive (`activeTurn` is false, so `liveWorkReason` correctly reports the case idle),
 * keep typing. Those appends land in `sessions/<id>.jsonl`, `turns`, `tool_calls` and
 * `messages_fts` after the bundle snapshot, and step 4 of the archive deletes all four.
 *
 * The mirror-construction count below is the load-bearing assertion, not decoration: it is what
 * proves the second send really took the WARM path. A test that only checked the rejection would
 * still pass against a build where the freeze fired from a newly-constructed mirror.
 */

let tmp: string, argusHome: string, db: DatabaseSync, events: AgentEvent[]
const detection = createDetection()
const SLUG = 'FRZ-1'

function fakeCreateQuery(): { createQuery: CreateQueryFn; queues: AsyncQueue<unknown>[] } {
  const queues: AsyncQueue<unknown>[] = []
  const createQuery: CreateQueryFn = (args) => {
    const options = args.options as Record<string, unknown>
    const q = new AsyncQueue<unknown>()
    // Only a real session query carries a systemPrompt; the Claude driver's catalog probe does
    // not (see registry.test.ts's copy of this helper).
    if (options.systemPrompt) queues.push(q)
    return Object.assign(
      { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
      { interrupt: async () => q.end() }
    )
  }
  return { createQuery, queues }
}

/** A `mirrorFactory` exactly as index.ts builds one, plus a construction counter. */
function countingMirrorFactory(): {
  factory: (caseSlug: string, sessionId: number) => SessionMirror
  count: () => number
} {
  let built = 0
  return {
    factory: (caseSlug: string, sessionId: number) => {
      const rec = db.prepare(`SELECT id FROM cases WHERE slug = ?`).get(caseSlug) as { id: number }
      const m = new SessionMirror(
        db,
        path.join(caseDir(argusHome, caseSlug), 'sessions', `${sessionId}.jsonl`),
        { caseId: rec.id, sessionId, caseSlug }
      )
      built++
      return m
    },
    count: () => built
  }
}

function turnCount(): number {
  return Number(
    (
      db
        .prepare(
          `SELECT count(*) AS n FROM turns WHERE case_id = (SELECT id FROM cases WHERE slug = ?)`
        )
        .get(SLUG) as { n: number }
    ).n
  )
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-frz-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  events = []
  createCase(db, argusHome, { slug: SLUG, title: 'frozen' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a WARM session obeys the archive freeze', () => {
  it('refuses a SECOND send into a session already live in the map', async () => {
    const { createQuery, queues } = fakeCreateQuery()
    const mirrors = countingMirrorFactory()
    const svc = new AgentService({
      queue: createImmediateQueue(db, argusHome),
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      githubWatermark: () => ({ enabled: false, text: '' }),
      onEvent: (e) => events.push(e),
      createQuery,
      mirrorFactory: mirrors.factory
    })
    const s = createSession(db, SLUG, 'claude-agent-sdk')

    // Turn 1 completes, exactly as it does before the user clicks Archive.
    await svc.send(SLUG, s.id, 'why does the needle keep coming back?')
    queues[0].push({ type: 'result', is_error: false })
    await new Promise((r) => setTimeout(r, 10))
    const [state] = svc.states()
    expect(state.state, 'the session must still be live in the map').toBe('running')
    expect(state.activeTurn, 'and idle — which is what lets archiveCase proceed').toBe(false)
    expect(mirrors.count()).toBe(1)
    const turnsBefore = turnCount()
    expect(turnsBefore).toBe(1)
    // The mirror flushes on a 250ms timer, so wait past it and snapshot the real bytes. Asserting
    // the transcript is NON-EMPTY first is what keeps the comparison below from being vacuous: a
    // missing file would otherwise "prove" nothing was appended.
    const transcript = path.join(caseDir(argusHome, SLUG), 'sessions', `${s.id}.jsonl`)
    await new Promise((r) => setTimeout(r, 300))
    const bytesBefore = fs.readFileSync(transcript, 'utf8')
    expect(bytesBefore.length).toBeGreaterThan(0)

    // Archive takes the freeze and spends seconds to minutes verifying the bundle. The chat pane
    // stays open; the user types again.
    const freeze = freezeCase(SLUG, 'archive')
    try {
      await expect(svc.send(SLUG, s.id, 'one more thought, typed mid-archive')).rejects.toThrow(
        /being archived right now and cannot accept new files/i
      )
    } finally {
      freeze.release()
    }

    // No SECOND mirror was built — which is the proof the refused send went through the warm
    // `return existing` branch, the one nothing guarded.
    expect(mirrors.count(), 'the send took the warm path, not a reconstruction').toBe(1)
    // And nothing of that message reached the four things the archive is about to delete.
    expect(turnCount(), 'a turn row was written during the freeze').toBe(turnsBefore)
    await new Promise((r) => setTimeout(r, 300))
    expect(
      fs.readFileSync(transcript, 'utf8'),
      'the transcript the bundle has already snapshotted grew during the freeze'
    ).toBe(bytesBefore)

    await svc.stopAll()
  })

  it('lets the same warm session through again once the freeze is released', async () => {
    // The other half of the refusal: the guard must be transient, not a session the freeze
    // permanently poisons. Without this a "fix" that simply evicted or wedged the session on
    // refusal would pass the test above.
    const { createQuery, queues } = fakeCreateQuery()
    const svc = new AgentService({
      queue: createImmediateQueue(db, argusHome),
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      githubWatermark: () => ({ enabled: false, text: '' }),
      onEvent: (e) => events.push(e),
      createQuery
    })
    const s = createSession(db, SLUG, 'claude-agent-sdk')
    await svc.send(SLUG, s.id, 'first')
    queues[0].push({ type: 'result', is_error: false })
    await new Promise((r) => setTimeout(r, 10))

    // try/finally, not a bare release: the freeze registry is module-scoped and keyed by slug,
    // so a failing assertion here would leak this freeze into every later test in the file and
    // report them all as broken for the wrong reason.
    const freeze = freezeCase(SLUG, 'archive')
    try {
      await expect(svc.send(SLUG, s.id, 'refused')).rejects.toThrow(/being archived/i)
    } finally {
      freeze.release()
    }

    await expect(svc.send(SLUG, s.id, 'allowed again')).resolves.toBeTypeOf('number')
    await svc.stopAll()
  })

  it('refuses a warm session on an ARCHIVED case, using the durable flag', async () => {
    // The freeze is in-process and released when the archive finishes; from then on
    // `cases.archived_at` is the guard. A warm session outliving the archive must hit that one.
    const { createQuery, queues } = fakeCreateQuery()
    const svc = new AgentService({
      queue: createImmediateQueue(db, argusHome),
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      githubWatermark: () => ({ enabled: false, text: '' }),
      onEvent: (e) => events.push(e),
      createQuery
    })
    const s = createSession(db, SLUG, 'claude-agent-sdk')
    await svc.send(SLUG, s.id, 'first')
    queues[0].push({ type: 'result', is_error: false })
    await new Promise((r) => setTimeout(r, 10))

    db.prepare(`UPDATE cases SET archived_at = ? WHERE slug = ?`).run(
      new Date().toISOString(),
      SLUG
    )
    await expect(svc.send(SLUG, s.id, 'after the seal')).rejects.toThrow(
      /is archived and cannot accept new files/i
    )
    await svc.stopAll()
  })

  it('refuses a warm session mid-RESTORE too, naming the restore', async () => {
    // restoreCase holds the identical freeze, and an append inside its window is clobbered by
    // the tree merge or deleted by reconcileSessions. The message must name the operation
    // actually running — the reason `freezeCase` records it.
    const { createQuery, queues } = fakeCreateQuery()
    const svc = new AgentService({
      queue: createImmediateQueue(db, argusHome),
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      githubWatermark: () => ({ enabled: false, text: '' }),
      onEvent: (e) => events.push(e),
      createQuery
    })
    const s = createSession(db, SLUG, 'claude-agent-sdk')
    await svc.send(SLUG, s.id, 'first')
    queues[0].push({ type: 'result', is_error: false })
    await new Promise((r) => setTimeout(r, 10))

    const freeze = freezeCase(SLUG, 'restore')
    try {
      await expect(svc.send(SLUG, s.id, 'typed mid-restore')).rejects.toThrow(
        /being restored right now/i
      )
    } finally {
      freeze.release()
    }
    await svc.stopAll()
  })
})
