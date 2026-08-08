import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { getCase } from '../../caseService'
import { listRoutineRuns } from '../runs'
import { RoutineStore } from '../store'
import { RoutinesService } from '../service'
import type { BackgroundTurnParams } from '../../agent/background'
import {
  MAX_INTERVAL_MINUTES,
  type RoutineDef,
  type RoutineSchedule,
  type RoutinesPayload
} from '../../../../shared/routines'

let home: string
let db: DatabaseSync
let store: RoutineStore
const NOW = new Date('2026-08-03T02:00:00.000Z')

const PREAMBLE =
  `You are running unattended as the routine "Sweep". No user is present: ` +
  `never ask questions, make reasonable assumptions, note anything that needs human ` +
  `review, and end with a concise summary of what you did and found.\n\n`

// The watermark sentence for a routine with no prior successful run — this is what run 1 of any
// fresh routine sees, appended to PREAMBLE above.
const FIRST_RUN_WATERMARK = `This is the first run of this routine — there is no previous run to compare against.\n\n`

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rsvc-'))
  db = openDb(path.join(home, 'argus.db'))
  store = new RoutineStore(home)
  store.upsert({ id: 'sweep', name: 'Sweep', prompt: 'sweep it', timeoutMs: 1000 })
})
afterEach(() => {
  store.close()
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const sessionRows = (): { id: number; driver_kind: string; model: string | null }[] =>
  db.prepare(`SELECT id, driver_kind, model FROM sessions ORDER BY id`).all() as unknown as {
    id: number
    driver_kind: string
    model: string | null
  }[]

const caseCount = (): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM cases`).get() as unknown as { n: number }).n

describe('RoutinesService', () => {
  it('runs a routine end to end: case, session row, run record, summary', async () => {
    const calls: BackgroundTurnParams[] = []
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async (p) => {
        calls.push(p)
        return { status: 'ok', text: 'nothing new' }
      },
      now: () => NOW
    })
    svc.startRun('sweep')
    await svc.whenIdle()

    const rec = getCase(db, 'routine-sweep')
    expect(rec).toBeTruthy()
    expect(rec?.title).toBe('Routine: Sweep')

    expect(calls).toHaveLength(1)
    expect(calls[0].caseId).toBe(rec!.id)
    expect(calls[0].caseSlug).toBe('routine-sweep')
    // Exact preamble, then the first-run watermark sentence, then the routine's own prompt.
    expect(calls[0].prompt).toBe(PREAMBLE + FIRST_RUN_WATERMARK + 'sweep it')
    expect(calls[0].timeoutMs).toBe(1000)
    expect(calls[0].model).toBeUndefined()

    const sessions = sessionRows()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].driver_kind).toBe('claude-agent-sdk')
    expect(sessions[0].model).toBeNull()
    expect(calls[0].sessionId).toBe(sessions[0].id)

    const [run] = listRoutineRuns(db)
    expect(run).toMatchObject({
      routineId: 'sweep',
      caseSlug: 'routine-sweep',
      status: 'ok',
      summary: 'nothing new',
      error: null,
      sessionId: calls[0].sessionId,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString()
    })
  })

  it('honours driverKind and model overrides', async () => {
    store.upsert({
      id: 'sweep',
      name: 'Sweep',
      prompt: 'sweep it',
      timeoutMs: 1000,
      driverKind: 'copilot',
      model: 'gpt-5'
    })
    const calls: BackgroundTurnParams[] = []
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async (p) => {
        calls.push(p)
        return { status: 'ok', text: 'done' }
      }
    })
    svc.startRun('sweep')
    await svc.whenIdle()
    expect(calls[0].model).toBe('gpt-5')
    const sessions = sessionRows()
    expect(sessions[0].driver_kind).toBe('copilot')
    expect(sessions[0].model).toBe('gpt-5')
  })

  it('reuses the routine case on the second run', async () => {
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => ({ status: 'ok', text: 'ok' })
    })
    svc.startRun('sweep')
    await svc.whenIdle()
    svc.startRun('sweep')
    await svc.whenIdle()

    expect(caseCount()).toBe(1)
    expect(listRoutineRuns(db)).toHaveLength(2)
    expect(sessionRows()).toHaveLength(2)
  })

  it('coalesces while busy instead of throwing, and still rejects unknown/disabled ids', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => {
        await gate
        return { status: 'ok', text: '' }
      }
    })
    svc.startRun('sweep')
    // Increment 1 threw here. Now a routine already running is coalesced (silently skipped)
    // rather than rejected — see the pending-queue describe block below for the queueing
    // contract itself. This test keeps its original job: proving id validation still runs and
    // still throws, and that a busy engine no longer does.
    expect(() => svc.startRun('sweep')).not.toThrow()
    expect(svc.payload().queued).toEqual([])
    // Validation of the id must not be masked by the busy check.
    expect(() => svc.startRun('nope')).toThrow(/Unknown routine: nope/)
    release()
    await svc.whenIdle()
    // Only the one accepted run ever reached the DB — the coalesced duplicate never queued.
    expect(listRoutineRuns(db)).toHaveLength(1)

    store.upsert({ id: 'off', name: 'Off', prompt: 'x', enabled: false })
    expect(() => svc.startRun('off')).toThrow(/Routine is disabled: off/)
    // A rejected startRun leaves the service idle and writes nothing.
    await svc.whenIdle()
    expect(listRoutineRuns(db)).toHaveLength(1)
    expect(svc.payload().runningId).toBeNull()
  })

  it('records failed when runTurn rejects — no running row left behind', async () => {
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => {
        throw new Error('driver exploded')
      }
    })
    svc.startRun('sweep')
    await expect(svc.whenIdle()).resolves.toBeUndefined()
    const [run] = listRoutineRuns(db)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/driver exploded/)
    expect(run.finishedAt).toBeTruthy()
    expect(listRoutineRuns(db).filter((r) => r.status === 'running')).toEqual([])
    // The service is idle again and accepts the next run.
    expect(svc.payload().runningId).toBeNull()
    expect(() => svc.startRun('sweep')).not.toThrow()
    // This second run must settle before the test (and its afterEach db.close/rmSync) ends —
    // otherwise it's left in flight against fixtures that are about to be torn down.
    await svc.whenIdle()
  })

  it('records a failed run when case/session setup throws — never a stuck running row', async () => {
    // argusHome is a FILE, so createCase's mkdir of the case dir throws.
    const blocked = path.join(home, 'blocked')
    fs.writeFileSync(blocked, 'not a directory')
    let ran = false
    const svc = new RoutinesService({
      db,
      argusHome: blocked,
      store,
      runTurn: async () => {
        ran = true
        return { status: 'ok', text: 'x' }
      }
    })
    svc.startRun('sweep')
    await expect(svc.whenIdle()).resolves.toBeUndefined()
    expect(ran).toBe(false)
    const [run] = listRoutineRuns(db)
    expect(run.status).toBe('failed')
    expect(run.error).toBeTruthy()
    expect(listRoutineRuns(db).filter((r) => r.status === 'running')).toEqual([])
    expect(svc.payload().runningId).toBeNull()
  })

  it('maps timeout and failed results, keeping partial text as the summary', async () => {
    const svcTimeout = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => ({
        status: 'timeout',
        text: 'got partway',
        error: 'timed out after 1000ms'
      })
    })
    svcTimeout.startRun('sweep')
    await svcTimeout.whenIdle()
    expect(listRoutineRuns(db)[0]).toMatchObject({
      status: 'timeout',
      summary: 'got partway',
      error: 'timed out after 1000ms'
    })

    const svcFailed = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => ({ status: 'failed', text: '', error: 'session exited' })
    })
    svcFailed.startRun('sweep')
    await svcFailed.whenIdle()
    expect(listRoutineRuns(db)[0]).toMatchObject({
      status: 'failed',
      summary: null,
      error: 'session exited'
    })
  })

  it('whenIdle resolves when nothing has ever run', async () => {
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => ({ status: 'ok', text: '' })
    })
    await expect(svc.whenIdle()).resolves.toBeUndefined()
  })

  it('payload() reports routines, runningId, and runs; notify fires at start and finish', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const seen: RoutinesPayload[] = []
    const notify = vi.fn(() => {
      seen.push(svc.payload())
    })
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      notify,
      runTurn: async () => {
        await gate
        return { status: 'ok', text: 'swept' }
      }
    })

    const before = svc.payload()
    expect(before.routines.map((r) => r.id)).toEqual(['sweep'])
    expect(before.loadError).toBeNull()
    expect(before.runningId).toBeNull()
    expect(before.runs).toEqual([])

    svc.startRun('sweep')
    const during = svc.payload()
    expect(during.runningId).toBe('sweep')
    expect(during.runs[0]).toMatchObject({ routineId: 'sweep', status: 'running' })

    release()
    await svc.whenIdle()

    const after = svc.payload()
    expect(after.runningId).toBeNull()
    expect(after.runs[0]).toMatchObject({ status: 'ok', summary: 'swept' })

    // Four notifications, now that startRun goes through the pending queue: the routine joining
    // the queue (task 5), run opened (no session yet), session attached while still running
    // (the fix under test), and the settled finish. A consumer watching notify must be able to
    // open the live agent session the moment it exists, not only after the run completes.
    expect(notify).toHaveBeenCalledTimes(4)

    // The enqueue notification: nothing has started yet, `sweep` is only queued. `drain` runs
    // synchronously right after this (nothing else was running), so this is a same-tick, real
    // transition rather than a state the caller could otherwise observe.
    expect(seen[0]).toMatchObject({ runningId: null, queued: ['sweep'] })
    expect(seen[0].runs).toEqual([])

    expect(seen[1]).toMatchObject({ runningId: 'sweep', queued: [] })
    expect(seen[1].runs[0]).toMatchObject({ status: 'running', sessionId: null })

    // The session-link notification: still running, but sessionId is now populated and matches
    // the session row actually created for this run.
    const sessionId = sessionRows()[0].id
    expect(seen[2]).toMatchObject({ runningId: 'sweep' })
    expect(seen[2].runs[0]).toMatchObject({ status: 'running', sessionId })

    // The finish notification must already show the settled state, not a stale running one.
    expect(seen[3].runningId).toBeNull()
    expect(seen[3].runs[0]).toMatchObject({ status: 'ok', summary: 'swept', sessionId })
  })
})

describe('watermark', () => {
  it('tells a first run that it is the first', async () => {
    const calls: BackgroundTurnParams[] = []
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async (p) => {
        calls.push(p)
        return { status: 'ok', text: 'done' }
      },
      now: () => NOW
    })
    svc.startRun('sweep')
    await svc.whenIdle()
    expect(calls[0].prompt).toContain('This is the first run of this routine')
    expect(calls[0].prompt).toContain('sweep it')
  })

  it('hands the next run the last SUCCESSFUL finish time', async () => {
    const calls: BackgroundTurnParams[] = []
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async (p) => {
        calls.push(p)
        return { status: 'ok', text: 'done' }
      },
      now: () => NOW
    })
    svc.startRun('sweep')
    await svc.whenIdle()
    svc.startRun('sweep')
    await svc.whenIdle()
    expect(calls[1].prompt).toContain(NOW.toISOString())
    expect(calls[1].prompt).toContain('changed since')
    expect(calls[1].prompt).not.toContain('first run')
  })

  it('does not advance the watermark past a failed run', async () => {
    const calls: BackgroundTurnParams[] = []
    let outcome: 'ok' | 'failed' = 'failed'
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async (p) => {
        calls.push(p)
        return outcome === 'ok'
          ? { status: 'ok', text: 'done' }
          : { status: 'failed', text: '', error: 'boom' }
      },
      now: () => NOW
    })
    svc.startRun('sweep')
    await svc.whenIdle()
    outcome = 'ok'
    svc.startRun('sweep')
    await svc.whenIdle()
    // Run 2 follows a FAILED run 1, so it is still the first run that matters.
    expect(calls[1].prompt).toContain('This is the first run of this routine')
  })
})

describe('pending queue', () => {
  /** A runTurn that only settles when the returned `release` is called. */
  const gated = (): {
    runTurn: (p: BackgroundTurnParams) => Promise<{ status: 'ok'; text: string }>
    started: string[]
    release: () => void
  } => {
    const started: string[] = []
    let unblock: () => void = () => {}
    const gate = new Promise<void>((r) => {
      unblock = r
    })
    return {
      started,
      release: () => unblock(),
      runTurn: async (p) => {
        started.push(p.caseSlug)
        await gate
        return { status: 'ok', text: 'done' }
      }
    }
  }

  beforeEach(() => {
    store.upsert({ id: 'second', name: 'Second', prompt: 'also sweep', timeoutMs: 1000 })
  })

  it('queues a second routine instead of throwing, and drains it', async () => {
    const g = gated()
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: g.runTurn,
      now: () => NOW
    })
    svc.startRun('sweep')
    expect(() => svc.startRun('second')).not.toThrow()
    expect(svc.payload().queued).toEqual(['second'])
    expect(svc.payload().runningId).toBe('sweep')
    g.release()
    await svc.whenIdle()
    expect(g.started).toEqual(['routine-sweep', 'routine-second'])
    expect(svc.payload().queued).toEqual([])
    expect(listRoutineRuns(db)).toHaveLength(2)
  })

  it('coalesces: a routine already running is not queued again', async () => {
    const g = gated()
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: g.runTurn,
      now: () => NOW
    })
    svc.startRun('sweep')
    svc.startRun('sweep')
    svc.startRun('sweep')
    expect(svc.payload().queued).toEqual([])
    g.release()
    await svc.whenIdle()
    expect(g.started).toEqual(['routine-sweep'])
  })

  it('coalesces: a routine already queued is not queued twice', async () => {
    const g = gated()
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: g.runTurn,
      now: () => NOW
    })
    svc.startRun('sweep')
    svc.startRun('second')
    svc.startRun('second')
    expect(svc.payload().queued).toEqual(['second'])
    g.release()
    await svc.whenIdle()
    expect(g.started).toEqual(['routine-sweep', 'routine-second'])
  })

  /**
   * The queue can hold a routine behind a run of up to MAX_TIMEOUT_MINUTES, and there is no
   * cancel anywhere in the product — so disabling or deleting it is the only lever the user has
   * while it waits. Executing the enqueue-time snapshot ignored both, and ran a routine the
   * user had just switched off.
   */
  it('skips a queued routine that was disabled while it waited, and drains the rest', async () => {
    store.upsert({ id: 'third', name: 'Third', prompt: 'and third', timeoutMs: 1000 })
    const g = gated()
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: g.runTurn,
      now: () => NOW
    })
    svc.startRun('sweep')
    svc.startRun('second')
    svc.startRun('third')
    expect(svc.payload().queued).toEqual(['second', 'third'])

    store.upsert({
      id: 'second',
      name: 'Second',
      prompt: 'also sweep',
      timeoutMs: 1000,
      enabled: false
    })
    g.release()
    await svc.whenIdle()

    expect(g.started).toEqual(['routine-sweep', 'routine-third'])
    // Nothing recorded either: a skipped routine is not a run that happened.
    expect(
      listRoutineRuns(db)
        .map((r) => r.routineId)
        .sort()
    ).toEqual(['sweep', 'third'])
    expect(svc.payload().queued).toEqual([])
  })

  it('skips a queued routine that was deleted while it waited, and drains the rest', async () => {
    store.upsert({ id: 'third', name: 'Third', prompt: 'and third', timeoutMs: 1000 })
    const g = gated()
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: g.runTurn,
      now: () => NOW
    })
    svc.startRun('sweep')
    svc.startRun('second')
    svc.startRun('third')

    store.remove('second')
    g.release()
    await svc.whenIdle()

    expect(g.started).toEqual(['routine-sweep', 'routine-third'])
    expect(
      listRoutineRuns(db)
        .map((r) => r.routineId)
        .sort()
    ).toEqual(['sweep', 'third'])
  })

  it('executes the CURRENT definition, not the one snapshotted at enqueue time', async () => {
    const calls: BackgroundTurnParams[] = []
    const g = gated()
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async (p) => {
        calls.push(p)
        return g.runTurn(p)
      },
      now: () => NOW
    })
    svc.startRun('sweep')
    svc.startRun('second')
    // Edited while it waits. The snapshot would run the old prompt — silently, unattended.
    store.upsert({ id: 'second', name: 'Second', prompt: 'the edited prompt', timeoutMs: 1000 })
    g.release()
    await svc.whenIdle()
    expect(calls[1].prompt).toContain('the edited prompt')
  })

  it('drains the queue even when the run ahead of it fails', async () => {
    const seen: string[] = []
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async (p) => {
        seen.push(p.caseSlug)
        if (p.caseSlug === 'routine-sweep') throw new Error('boom')
        return { status: 'ok', text: 'done' }
      },
      now: () => NOW
    })
    svc.startRun('sweep')
    svc.startRun('second')
    await svc.whenIdle()
    expect(seen).toEqual(['routine-sweep', 'routine-second'])
  })

  it('whenIdle waits for the whole queue, not just the run in flight', async () => {
    const g = gated()
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: g.runTurn,
      now: () => NOW
    })
    svc.startRun('sweep')
    svc.startRun('second')
    g.release()
    await svc.whenIdle()
    // If whenIdle resolved on the first run alone, the second would still be pending here —
    // and shutdown, which awaits this, would cut it off mid-turn.
    expect(svc.payload().queued).toEqual([])
    expect(svc.payload().runningId).toBeNull()
    expect(g.started).toHaveLength(2)
  })

  it('records the trigger the run was enqueued with', async () => {
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => ({ status: 'ok', text: 'done' }),
      now: () => NOW
    })
    const sweep = store.get('sweep')!
    svc.enqueue(sweep, 'catchup')
    await svc.whenIdle()
    expect(listRoutineRuns(db)[0].trigger).toBe('catchup')
  })

  it('survives a throwing notify: the queue keeps draining and whenIdle still resolves', async () => {
    // A `notify` this hostile is realistic: production's wraps webContents.send, which throws
    // "Object has been destroyed" when a window closes mid-run. Nothing in the service is
    // allowed to depend on the caller having wrapped it — see drain()'s `.finally()`, which
    // must reach `this.drain()` (the serial-queue continuation) even when this throws.
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      notify: () => {
        throw new Error('window destroyed')
      },
      runTurn: async () => ({ status: 'ok', text: 'done' }),
      now: () => NOW
    })
    svc.startRun('sweep')
    svc.startRun('second')
    await svc.whenIdle()

    // Both routines actually ran — a stalled queue would leave 'second' (or both) stuck behind
    // an uncaught throw, never reaching runTurn at all.
    expect(listRoutineRuns(db)).toHaveLength(2)
    expect(
      listRoutineRuns(db)
        .map((r) => r.caseSlug)
        .sort()
    ).toEqual(['routine-second', 'routine-sweep'])
    expect(svc.payload().queued).toEqual([])
    expect(svc.payload().runningId).toBeNull()
  })
})

describe('nextRunAt', () => {
  const HOUR = 3_600_000
  /** App boot. Everything below measures the gap between this and the comparison clock. */
  const BOOT = new Date('2026-08-08T01:00:00.000Z')

  /**
   * A clock that can be stepped forward AFTER the service is constructed.
   *
   * A constant clock structurally cannot see the defect these tests exist for: with `now` fixed,
   * construction time and comparison time are the same instant, so anchoring on either looks
   * identical. In production the gap between them is app uptime, which is routinely days.
   */
  const stepping = (start: Date): { now: () => Date; advance: (ms: number) => void } => {
    let t = start
    return {
      now: () => t,
      advance: (ms) => {
        t = new Date(t.getTime() + ms)
      }
    }
  }

  const build = (now: () => Date = () => NOW): RoutinesService =>
    new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => ({ status: 'ok', text: 'done' }),
      now
    })

  it('is null for a manual-only routine', () => {
    expect(build().nextRunAt(store.get('sweep')!)).toBeNull()
  })

  it('is null for a disabled routine even when it has a schedule', () => {
    // One rule in one place: the scheduler and the Settings page both get this for free.
    store.upsert({
      id: 'off',
      name: 'Off',
      prompt: 'x',
      enabled: false,
      schedule: { kind: 'interval', everyMinutes: 60 }
    })
    expect(build().nextRunAt(store.get('off')!)).toBeNull()
  })

  /**
   * The regression guard for the defect the whole-branch review found: a never-run routine used
   * to anchor on SERVICE CONSTRUCTION (app boot in production), so once uptime exceeded the
   * schedule's period every newly saved routine was already overdue and launched an unattended
   * run within one scheduler tick.
   *
   * The assertion is against the clock the scheduler will compare against — not against a
   * precomputed ISO string, which is what the test this replaced did and why it never noticed.
   */
  const FRESH_SCHEDULES: [string, RoutineSchedule][] = [
    ['interval', { kind: 'interval', everyMinutes: 60 }],
    ['daily', { kind: 'daily', at: '02:00' }],
    ['weekly', { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], at: '02:00' }]
  ]
  it.each(FRESH_SCHEDULES)(
    'a %s routine first seen now is due in the future, never immediately',
    (_kind, schedule) => {
      const clock = stepping(BOOT)
      const svc = build(clock.now)
      // Two days of uptime before the user saves the routine — the reported scenario.
      clock.advance(48 * HOUR)
      store.upsert({ id: 'fresh', name: 'Fresh', prompt: 'x', schedule })

      const due = svc.nextRunAt(store.get('fresh')!)
      expect(due).toBeTruthy()
      expect(new Date(due!).getTime()).toBeGreaterThan(clock.now().getTime())
    }
  )

  it('keeps a never-run routine anchored across a restart instead of receding on every launch', () => {
    // MAX_INTERVAL_MINUTES (one week) on a machine rebooted more often than that is scenario
    // (c): with a boot-time anchor the fire moves forward every launch and the routine can
    // never run at all. The anchor row is what makes it converge.
    store.upsert({
      id: 'sweep',
      name: 'Sweep',
      prompt: 'sweep it',
      timeoutMs: 1000,
      schedule: { kind: 'interval', everyMinutes: MAX_INTERVAL_MINUTES }
    })
    const first = build(() => BOOT).nextRunAt(store.get('sweep')!)
    expect(first).toBe(new Date(BOOT.getTime() + MAX_INTERVAL_MINUTES * 60_000).toISOString())

    // A second service over the SAME db three days later — a restart, with no run in between.
    const later = new Date(BOOT.getTime() + 3 * 24 * HOUR)
    expect(build(() => later).nextRunAt(store.get('sweep')!)).toBe(first)
  })

  it('gives a routine recreated under the same id a fresh anchor', () => {
    // Ids are derived from the name, so delete-then-recreate lands on the same id. A surviving
    // anchor row from weeks ago would make the recreated routine overdue the instant it saved —
    // the original defect, resurrected through the store.
    const schedule = { kind: 'interval', everyMinutes: 60 } as const
    store.upsert({ id: 'sweep', name: 'Sweep', prompt: 'sweep it', timeoutMs: 1000, schedule })
    expect(build(() => BOOT).nextRunAt(store.get('sweep')!)).toBe(
      new Date(BOOT.getTime() + HOUR).toISOString()
    )

    store.remove('sweep')
    build(() => BOOT).forgetRoutine('sweep')

    const later = new Date(BOOT.getTime() + 10 * 24 * HOUR)
    store.upsert({ id: 'sweep', name: 'Sweep', prompt: 'sweep it', timeoutMs: 1000, schedule })
    expect(build(() => later).nextRunAt(store.get('sweep')!)).toBe(
      new Date(later.getTime() + HOUR).toISOString()
    )
  })

  it('anchors on the last attempt once one exists', async () => {
    store.upsert({
      id: 'sweep',
      name: 'Sweep',
      prompt: 'sweep it',
      timeoutMs: 1000,
      schedule: { kind: 'interval', everyMinutes: 60 }
    })
    const svc = build()
    svc.startRun('sweep')
    await svc.whenIdle()
    // NOW is the injected clock the run row was written with.
    expect(svc.nextRunAt(store.get('sweep')!)).toBe(
      new Date(NOW.getTime() + 60 * 60_000).toISOString()
    )
  })

  it('is reported per routine in the payload', () => {
    store.upsert({
      id: 'sweep',
      name: 'Sweep',
      prompt: 'sweep it',
      timeoutMs: 1000,
      schedule: { kind: 'interval', everyMinutes: 60 }
    })
    store.upsert({ id: 'manual', name: 'Manual', prompt: 'x' })
    expect(build().payload().nextRunAt).toEqual({
      sweep: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
      manual: null
    })
  })

  it('does not let one routine with a hand-edited, schema-busting schedule blank the whole payload()', () => {
    // RoutineStore's own zod gate is exactly what makes this unreachable in production (a
    // routine this broken reverts the whole file to defaults instead). Bypassing it with a
    // minimal stub store is the legitimate way to exercise payload()'s own guard in isolation —
    // RoutineStore itself is untouched.
    const healthy: RoutineDef = {
      id: 'healthy',
      name: 'Healthy',
      prompt: 'x',
      timeoutMs: 1000,
      schedule: { kind: 'interval', everyMinutes: 60 },
      enabled: true
    }
    // everyMinutes <= 0 is one of nextFireAfter's two throw sites (schedule.ts). No production
    // path produces it — RoutineStore's zod gate and its parse-the-whole-file idiom see to that,
    // which is why the stub store above is needed to reach payload()'s guard at all.
    const broken: RoutineDef = {
      id: 'broken',
      name: 'Broken',
      prompt: 'x',
      timeoutMs: 1000,
      schedule: { kind: 'interval', everyMinutes: 0 },
      enabled: true
    }
    const stubStore = {
      list: () => [broken, healthy],
      get: (id: string) => [broken, healthy].find((r) => r.id === id),
      loadError: () => null
    } as unknown as RoutineStore

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store: stubStore,
      runTurn: async () => ({ status: 'ok', text: 'done' }),
      now: () => NOW
    })

    let payload: RoutinesPayload | undefined
    expect(() => {
      payload = svc.payload()
    }).not.toThrow()

    expect(payload!.routines).toEqual([broken, healthy])
    expect(payload!.runs).toEqual([])
    expect(payload!.nextRunAt.broken).toBeNull()
    expect(payload!.nextRunAt.healthy).toBe(new Date(NOW.getTime() + 60 * 60_000).toISOString())
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[routines\].*broken/),
      expect.any(String)
    )
    errorSpy.mockRestore()
  })
})
