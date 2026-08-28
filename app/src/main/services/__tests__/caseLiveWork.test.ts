import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { caseLiveWorkReason, busyCaseSlugsOf } from '../caseLiveWork'
import { insertRoutineRun, finishRoutineRun } from '../routines/runs'
import { insertRunItem, attachItemCase, finishRunItem } from '../routines/runItems'
import { AgentService } from '../agent/registry'
import { createSession } from '../agent/sessionStore'
import { AsyncQueue } from '../agent/asyncQueue'
import { createImmediateQueue } from '../ingestQueue'
import { createDetection } from '../packs/detection'
import { defaultAgentAccess } from '../../../shared/agentAccess'
import type { CreateQueryFn } from '../agent/drivers/claude'

/**
 * The seam `main/index.ts` binds to `ArchiveDeps.liveWorkReason`. Tested here rather than through
 * the IPC handler because that handler is registered inline inside `registerIpc()`, and
 * `main/index.ts` imports `electron` at module scope so it cannot be imported into Vitest at all
 * (see main/__tests__/routinesIpc.test.ts, which reads it as source text for the same reason).
 * The handler-side wiring is pinned as source text in main/__tests__/caseArchiveIpc.test.ts;
 * the DECISION lives here, where it can be exercised for real.
 */
const opened: Array<{ db: DatabaseSync; home: string }> = []

function freshEnv(): { db: DatabaseSync; home: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-livework-')))
  const db = openDb(path.join(home, 'argus.db'))
  opened.push({ db, home })
  return { db, home }
}

function freshDb(): DatabaseSync {
  return freshEnv().db
}

afterEach(() => {
  while (opened.length) {
    const { db, home } = opened.pop()!
    try {
      db.close()
    } catch {
      /* already closed */
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
})

const idle = {
  busyCaseSlugs: (): string[] => [],
  openExternalApps: (): Array<{ packId: string; windowId: string }> => []
}

describe('caseLiveWorkReason', () => {
  it('is null for a case with no chats, no routine runs and no external apps', () => {
    expect(caseLiveWorkReason(freshDb(), 'KAN-1', idle)).toBeNull()
  })

  it('names the agent session while a foreground turn is in flight for that case', () => {
    const db = freshDb()
    const deps = { ...idle, busyCaseSlugs: () => ['KAN-1', 'KAN-9'] }
    expect(caseLiveWorkReason(db, 'KAN-1', deps)).toMatch(/agent session still running/i)
    // and scoped to the slug asked about, not "any case is busy"
    expect(caseLiveWorkReason(db, 'KAN-2', deps)).toBeNull()
  })

  it('names the routine run for an UNSCOPED run, which the session map cannot see', () => {
    const db = freshDb()
    // Exactly what RoutinesService.execute writes for an unscoped routine: the run row records
    // the `routine-<id>` case it opens. No entry is ever made in AgentService's live map for
    // that background session, so `busyCaseSlugs` stays empty throughout.
    const runId = insertRoutineRun(db, 'daily-triage', 'routine-daily-triage', 'scheduled')
    expect(caseLiveWorkReason(db, 'routine-daily-triage', idle)).toMatch(/routine run/i)

    finishRoutineRun(db, runId, { status: 'ok' })
    expect(caseLiveWorkReason(db, 'routine-daily-triage', idle)).toBeNull()
  })

  it('sees a SCOPED run working that case, whose slug lives only on the item row', () => {
    const db = freshDb()
    // A scoped run writes NULL to routine_runs.case_slug and records each item's case on
    // routine_run_items — so a check that consulted only routine_runs would miss every scoped
    // run, which is the common shape.
    const runId = insertRoutineRun(db, 'jql-sweep', null, 'scheduled')
    const itemId = insertRunItem(db, runId, 'KAN-7')
    attachItemCase(db, itemId, 'KAN-7')

    expect(caseLiveWorkReason(db, 'KAN-7', idle)).toMatch(/routine run/i)
    // a sibling case named by no item row is unaffected
    expect(caseLiveWorkReason(db, 'KAN-8', idle)).toBeNull()

    finishRunItem(db, itemId, { status: 'processed' })
    expect(caseLiveWorkReason(db, 'KAN-7', idle)).toBeNull()
  })

  it('ignores a FINISHED item of a run that is still going, and sees the one still going', () => {
    const db = freshDb()
    const runId = insertRoutineRun(db, 'jql-sweep', null, 'scheduled')
    const done = insertRunItem(db, runId, 'KAN-1')
    attachItemCase(db, done, 'KAN-1')
    finishRunItem(db, done, { status: 'processed' })
    const live = insertRunItem(db, runId, 'KAN-2')
    attachItemCase(db, live, 'KAN-2')

    // The run row is still `running`. The case it has MOVED ON from must be archivable.
    expect(caseLiveWorkReason(db, 'KAN-1', idle)).toBeNull()
    expect(caseLiveWorkReason(db, 'KAN-2', idle)).toMatch(/routine run/i)
  })

  it('ignores a run left `running` by a crash once boot reconciliation has closed it', () => {
    const db = freshDb()
    const runId = insertRoutineRun(db, 'daily-triage', 'routine-daily-triage', 'manual')
    finishRoutineRun(db, runId, { status: 'failed', error: 'interrupted' })
    expect(caseLiveWorkReason(db, 'routine-daily-triage', idle)).toBeNull()
  })

  it('refuses while an external app is open in the case dir, and names what to close', () => {
    const db = freshDb()
    // ExternalAppHost spawns an editor/terminal INTO the case directory. It holds no database
    // handle, so `assertCaseWritable` never sees its writes and the archive freeze cannot stop
    // them — refusing is the only honest answer, and the message has to say which app.
    const deps = {
      ...idle,
      openExternalApps: () => [{ packId: 'jetbrains', windowId: 'idea' }]
    }
    const reason = caseLiveWorkReason(db, 'KAN-1', deps)
    expect(reason).toMatch(/external app/i)
    expect(reason).toContain('jetbrains/idea')
    expect(reason).toMatch(/close it/i)
  })

  it('is null once the external app list is empty, so a closed editor unblocks the archive', () => {
    const db = freshDb()
    let apps: Array<{ packId: string; windowId: string }> = [
      { packId: 'shell', windowId: 'terminal' }
    ]
    const deps = { ...idle, openExternalApps: () => apps }
    expect(caseLiveWorkReason(db, 'KAN-1', deps)).toMatch(/external app/i)
    apps = []
    expect(caseLiveWorkReason(db, 'KAN-1', deps)).toBeNull()
  })
})

/**
 * The state NO other test in this branch constructs: a real AgentService whose session has
 * FINISHED its turn.
 *
 * The foreground half of the check used to be `states().map((s) => s.caseSlug)`, unfiltered.
 * `states()` maps every entry in the session map, entries are added on the first `send()` and
 * removed only by an explicit stop, a driver self-exit, or the LRU reap at `maxSessions`
 * (default 3) — there is no idle timer, and `state` is 'running' | 'dead', i.e. process
 * liveness, not turn activity. So the ordinary flow (investigate a case, finish, archive it)
 * was refused outright, and the user could not comply: nothing in the UI stops an idle session.
 *
 * The existing caseLiveWork tests could not see this at all, because they inject
 * `busyCaseSlugs` directly and therefore assert the composition, never what `states()` holds.
 * This one drives the real service.
 */
describe('busyCaseSlugsOf against a real AgentService', () => {
  function fakeCreateQuery(): { createQuery: CreateQueryFn; queues: AsyncQueue<unknown>[] } {
    const queues: AsyncQueue<unknown>[] = []
    const createQuery: CreateQueryFn = (args) => {
      const options = args.options as Record<string, unknown>
      // Same guard as registry.test.ts's helper: only a REAL session query sets systemPrompt.
      const q = new AsyncQueue<unknown>()
      if (options.systemPrompt) queues.push(q)
      return Object.assign(
        { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
        { interrupt: async () => q.end() }
      )
    }
    return { createQuery, queues }
  }

  it('drops a session whose turn has COMPLETED, so an ordinary case is archivable again', async () => {
    const { db, home } = freshEnv()
    createCase(db, home, { slug: 'NAV-1', title: 'NAV-1' })
    const { createQuery, queues } = fakeCreateQuery()
    const svc = new AgentService({
      queue: createImmediateQueue(db, home),
      db,
      argusHome: home,
      detection: createDetection(),
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      githubWatermark: () => ({ enabled: false, text: '' }),
      onEvent: () => {},
      createQuery
    })
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
    await svc.send('NAV-1', s.id, 'investigate this')

    // Mid-turn: the case genuinely IS busy and archiving must refuse it.
    expect(busyCaseSlugsOf(svc)).toEqual(['NAV-1'])
    expect(
      caseLiveWorkReason(db, 'NAV-1', { ...idle, busyCaseSlugs: () => busyCaseSlugsOf(svc) })
    ).toMatch(/agent session still running/i)

    // Finish the turn, exactly as the driver's result event does. NOTHING else changes: the
    // session stays in the map, `state` stays 'running', and `states()` still has length 1 —
    // which is why the unfiltered map could never report this case as archivable.
    queues[0].push({ type: 'result', is_error: false })
    await new Promise((r) => setTimeout(r, 20))
    expect(svc.states()).toHaveLength(1)
    expect(svc.states()[0].activeTurn).toBe(false)

    expect(busyCaseSlugsOf(svc)).toEqual([])
    expect(
      caseLiveWorkReason(db, 'NAV-1', { ...idle, busyCaseSlugs: () => busyCaseSlugsOf(svc) })
    ).toBeNull()

    await svc.stopAll()
  })
})
