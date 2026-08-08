import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { listRoutineRuns } from '../runs'
import { RoutineStore } from '../store'
import { RoutinesService } from '../service'
import { RoutineScheduler } from '../scheduler'
import type { BackgroundTurnParams } from '../../agent/background'

/**
 * The RoutinesService ↔ RoutineScheduler seam, composed for real.
 *
 * scheduler.test.ts injects a scripted `nextRunAt` in every case and service.test.ts never
 * builds a scheduler, so until this file existed the two halves were each proven against a
 * fiction of the other and their COMPOSITION was verified nowhere. That gap is not theoretical:
 * it is exactly how a never-run routine came to anchor on app boot — arithmetic that every
 * per-unit test agreed with, and that fired an unattended run the moment a routine was saved.
 *
 * Everything here is the production object except `runTurn` (no driver) and the clock, which is
 * injected and stepped by hand: real RoutineStore over a real temp home, real sqlite, real
 * service, real scheduler. `tick()` is called directly rather than through fake timers — it is
 * the same code `start()`'s interval calls, and the wall clock is the thing under test.
 */

const MINUTE = 60_000
const T0 = new Date('2026-08-08T01:00:00.000Z')

let home: string
let db: DatabaseSync
let store: RoutineStore
let clock: Date

const advance = (minutes: number): void => {
  clock = new Date(clock.getTime() + minutes * MINUTE)
}

interface Harness {
  svc: RoutinesService
  scheduler: RoutineScheduler
  started: string[]
  release: () => void
}

/** `gate` true holds every run open until `release()` — for the backlog case. */
function build(gate = false): Harness {
  const started: string[] = []
  let unblock: () => void = () => {}
  const held = new Promise<void>((r) => {
    unblock = r
  })
  const svc = new RoutinesService({
    db,
    argusHome: home,
    store,
    now: () => clock,
    runTurn: async (p: BackgroundTurnParams) => {
      started.push(p.caseSlug)
      if (gate) await held
      return { status: 'ok', text: 'done' }
    }
  })
  const scheduler = new RoutineScheduler({ store, service: svc, now: () => clock })
  return { svc, scheduler, started, release: () => unblock() }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rsched-'))
  db = openDb(path.join(home, 'argus.db'))
  store = new RoutineStore(home)
  clock = T0
})
afterEach(() => {
  store.close()
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const scheduled = (everyMinutes = 60): void => {
  store.upsert({
    id: 'sweep',
    name: 'Sweep',
    prompt: 'sweep it',
    timeoutMs: 1000,
    schedule: { kind: 'interval', everyMinutes }
  })
}

/**
 * The launch tick, at which a routine that already existed gains its anchor.
 *
 * Anchors are written lazily, by the first `nextRunAt` that sees the routine with a live
 * schedule — so a tick at the instant the tests treat as "the app was already up" is what makes
 * the clock arithmetic below start where it reads as starting. Production needs no equivalent:
 * the poll is every 30 seconds, and saving a routine reads `payload()` on the way back.
 */
const launchTick = (h: Harness): void => h.scheduler.tick()

describe('scheduler + service, composed', () => {
  it('fires once when the interval elapses, and the tick right after does not fire again', async () => {
    scheduled()
    const h = build()

    // Launch. The routine has never run, so this is also the catch-up pass — and a routine
    // first seen now must NOT be caught up on.
    h.scheduler.start()
    h.scheduler.stop()
    await h.svc.whenIdle()
    expect(h.started).toEqual([])

    advance(61)
    h.scheduler.tick()
    await h.svc.whenIdle()
    expect(h.started).toEqual(['routine-sweep'])

    // The loop terminates. The run just written is the new anchor, so the next fire is an hour
    // out — if it were not, the 30-second poll would re-run this routine forever, unattended.
    h.scheduler.tick()
    await h.svc.whenIdle()
    expect(h.started).toEqual(['routine-sweep'])
    expect(listRoutineRuns(db)).toHaveLength(1)
  })

  it('fires again once the next interval elapses — it does not silently stop after one', async () => {
    scheduled()
    const h = build()
    launchTick(h)
    advance(61)
    h.scheduler.tick()
    await h.svc.whenIdle()

    advance(61)
    h.scheduler.tick()
    await h.svc.whenIdle()
    expect(h.started).toEqual(['routine-sweep', 'routine-sweep'])
    const runs = listRoutineRuns(db)
    expect(runs).toHaveLength(2)
    expect(runs.every((r) => r.status === 'ok')).toBe(true)
  })

  it('does not fire a routine created mid-session, however long the app has been up', async () => {
    // The composed regression guard for the boot-anchor defect. Two days of uptime, then the
    // user saves a routine — which used to be enough to make it overdue on arrival.
    const h = build()
    h.scheduler.start()
    h.scheduler.stop()

    advance(48 * 60)
    scheduled()
    h.scheduler.tick()
    await h.svc.whenIdle()
    expect(h.started).toEqual([])
    expect(listRoutineRuns(db)).toEqual([])

    // And it does fire at its own first occurrence, an hour after it was saved.
    advance(61)
    h.scheduler.tick()
    await h.svc.whenIdle()
    expect(h.started).toEqual(['routine-sweep'])
  })

  it('does not stack up a backlog of a routine whose run outlasts its own interval', async () => {
    scheduled(5)
    const h = build(true)
    launchTick(h)
    advance(6)
    h.scheduler.tick()
    expect(h.svc.payload().runningId).toBe('sweep')

    // Four more intervals go by with the run still in flight. Each tick sees the routine due
    // (its anchor is the start of the run that has not finished) and each must coalesce.
    for (let i = 0; i < 4; i++) {
      advance(6)
      h.scheduler.tick()
    }
    expect(h.svc.payload().queued).toEqual([])
    expect(listRoutineRuns(db)).toHaveLength(1)

    h.release()
    await h.svc.whenIdle()
    expect(h.started).toEqual(['routine-sweep'])
    expect(listRoutineRuns(db)).toHaveLength(1)
  })

  it('labels a fire the app was closed for as catchup, and produces one run for a long absence', async () => {
    scheduled()
    // A run yesterday, then the app was shut. Written through the service so the anchor is a
    // real routine_runs row rather than a fixture.
    const first = build()
    launchTick(first)
    advance(61)
    first.scheduler.tick()
    await first.svc.whenIdle()

    // Next launch, three days later.
    advance(3 * 24 * 60)
    const next = build()
    next.scheduler.start()
    next.scheduler.stop()
    await next.svc.whenIdle()

    expect(next.started).toEqual(['routine-sweep'])
    const runs = listRoutineRuns(db)
    // Three days of missed hourly fires collapse to ONE run: nextRunAt computes a single next
    // fire from the anchor and never enumerates occurrences.
    expect(runs).toHaveLength(2)
    expect(runs[0].trigger).toBe('catchup')
  })
})
