import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import {
  insertRoutineRun,
  attachRunSession,
  finishRoutineRun,
  listRoutineRuns,
  reconcileInterruptedRuns,
  runningRoutineForSession,
  INTERRUPTED_RUN_ERROR
} from '../runs'

let home: string
let db: DatabaseSync
const NOW = new Date('2026-08-03T02:00:00.000Z')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-routines-'))
  db = openDb(path.join(home, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('routine_runs', () => {
  it('inserts a running row and finishes it ok with a summary', () => {
    const id = insertRoutineRun(db, 'nightly-sweep', 'routine-nightly-sweep', () => NOW)
    attachRunSession(db, id, 42)
    finishRoutineRun(db, id, { status: 'ok', summary: 'did the thing' }, () => NOW)
    const [run] = listRoutineRuns(db)
    expect(run).toMatchObject({
      id,
      routineId: 'nightly-sweep',
      caseSlug: 'routine-nightly-sweep',
      sessionId: 42,
      status: 'ok',
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      summary: 'did the thing',
      error: null
    })
  })

  it('records failures with error text and lists newest first', () => {
    const a = insertRoutineRun(db, 'r1', 'routine-r1', () => NOW)
    finishRoutineRun(db, a, { status: 'failed', error: 'boom' }, () => NOW)
    insertRoutineRun(db, 'r2', 'routine-r2', () => new Date('2026-08-03T03:00:00.000Z'))
    const runs = listRoutineRuns(db)
    expect(runs.map((r) => r.routineId)).toEqual(['r2', 'r1'])
    expect(runs[1].error).toBe('boom')
    expect(runs[1].status).toBe('failed')
  })
})

describe('reconcileInterruptedRuns', () => {
  const LATER = new Date('2026-08-03T09:00:00.000Z')

  it('closes out a run stranded by a crash: failed, explanatory error, finished timestamp', () => {
    const id = insertRoutineRun(db, 'nightly-sweep', 'routine-nightly-sweep', () => NOW)
    attachRunSession(db, id, 7)
    // No finishRoutineRun — this is exactly what a process dying mid-run leaves behind.
    expect(listRoutineRuns(db)[0]).toMatchObject({ status: 'running', finishedAt: null })

    expect(reconcileInterruptedRuns(db, () => LATER)).toBe(1)

    expect(listRoutineRuns(db)[0]).toMatchObject({
      id,
      status: 'failed',
      error: INTERRUPTED_RUN_ERROR,
      finishedAt: LATER.toISOString(),
      // Untouched: when it started and which session it was is still the useful part of the row.
      startedAt: NOW.toISOString(),
      sessionId: 7
    })
    expect(INTERRUPTED_RUN_ERROR).toMatch(/exited or crashed/)
  })

  it('leaves already-finished runs exactly as they were', () => {
    const ok = insertRoutineRun(db, 'r-ok', 'routine-r-ok', () => NOW)
    finishRoutineRun(db, ok, { status: 'ok', summary: 'all good' }, () => NOW)
    const failed = insertRoutineRun(db, 'r-failed', 'routine-r-failed', () => NOW)
    finishRoutineRun(db, failed, { status: 'failed', error: 'boom' }, () => NOW)
    const timeout = insertRoutineRun(db, 'r-timeout', 'routine-r-timeout', () => NOW)
    finishRoutineRun(db, timeout, { status: 'timeout', error: 'too slow' }, () => NOW)
    const before = listRoutineRuns(db)

    expect(reconcileInterruptedRuns(db, () => LATER)).toBe(0)

    expect(listRoutineRuns(db)).toEqual(before)
  })

  it('reports the count and reconciles only the stranded rows in a mixed table', () => {
    const done = insertRoutineRun(db, 'r-done', 'routine-r-done', () => NOW)
    finishRoutineRun(db, done, { status: 'ok', summary: 'kept' }, () => NOW)
    insertRoutineRun(db, 'r-a', 'routine-r-a', () => NOW)
    insertRoutineRun(db, 'r-b', 'routine-r-b', () => NOW)

    expect(reconcileInterruptedRuns(db, () => LATER)).toBe(2)

    const byId = new Map(listRoutineRuns(db).map((r) => [r.routineId, r]))
    expect(byId.get('r-a')).toMatchObject({ status: 'failed', error: INTERRUPTED_RUN_ERROR })
    expect(byId.get('r-b')).toMatchObject({ status: 'failed', error: INTERRUPTED_RUN_ERROR })
    expect(byId.get('r-done')).toMatchObject({ status: 'ok', summary: 'kept', error: null })
    expect(listRoutineRuns(db).filter((r) => r.status === 'running')).toEqual([])
  })

  it('is idempotent: a second pass changes nothing and reports 0', () => {
    insertRoutineRun(db, 'r-a', 'routine-r-a', () => NOW)
    expect(reconcileInterruptedRuns(db, () => LATER)).toBe(1)
    const afterFirst = listRoutineRuns(db)

    // A later `now` would be visible if the second pass rewrote the row.
    expect(reconcileInterruptedRuns(db, () => new Date('2026-08-04T00:00:00.000Z'))).toBe(0)

    expect(listRoutineRuns(db)).toEqual(afterFirst)
  })

  it('reports 0 on a clean previous shutdown (empty table)', () => {
    expect(reconcileInterruptedRuns(db, () => LATER)).toBe(0)
    expect(listRoutineRuns(db)).toEqual([])
  })
})

describe('runningRoutineForSession', () => {
  const AFTER = new Date('2026-08-03T03:00:00.000Z')

  it('names the routine occupying a session, and only while it is running', () => {
    const id = insertRoutineRun(db, 'nightly-sweep', 'routine-nightly-sweep', () => NOW)
    // Before the session row is attached there is nothing to collide with.
    expect(runningRoutineForSession(db, 42)).toBeNull()
    attachRunSession(db, id, 42)
    expect(runningRoutineForSession(db, 42)).toBe('nightly-sweep')
    // Scoped to the session it was asked about — an unrelated chat is never blocked.
    expect(runningRoutineForSession(db, 43)).toBeNull()
    finishRoutineRun(db, id, { status: 'ok', summary: 'done' }, () => AFTER)
    // The moment the run settles the session is ordinary again.
    expect(runningRoutineForSession(db, 42)).toBeNull()
  })

  it('a run stranded by a crash stops blocking once startup reconciles it', () => {
    // Otherwise a hard quit mid-run would lock that chat out permanently: nothing else ever
    // revisits those rows, and `status='running'` is exactly what the guard keys on.
    const id = insertRoutineRun(db, 'r-a', 'routine-r-a', () => NOW)
    attachRunSession(db, id, 7)
    expect(runningRoutineForSession(db, 7)).toBe('r-a')
    reconcileInterruptedRuns(db, () => AFTER)
    expect(runningRoutineForSession(db, 7)).toBeNull()
  })

  it('reports the newest run when a session somehow carries more than one', () => {
    const older = insertRoutineRun(db, 'r-a', 'routine-r-a', () => NOW)
    attachRunSession(db, older, 9)
    finishRoutineRun(db, older, { status: 'ok' }, () => NOW)
    const newer = insertRoutineRun(db, 'r-b', 'routine-r-b', () => NOW)
    attachRunSession(db, newer, 9)
    expect(runningRoutineForSession(db, 9)).toBe('r-b')
  })
})
