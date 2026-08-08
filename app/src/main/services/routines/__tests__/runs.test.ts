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
  lastAttemptAt,
  lastSuccessAt,
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
    const id = insertRoutineRun(db, 'nightly-sweep', 'routine-nightly-sweep', 'manual', () => NOW)
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
    const a = insertRoutineRun(db, 'r1', 'routine-r1', 'manual', () => NOW)
    finishRoutineRun(db, a, { status: 'failed', error: 'boom' }, () => NOW)
    insertRoutineRun(db, 'r2', 'routine-r2', 'manual', () => new Date('2026-08-03T03:00:00.000Z'))
    const runs = listRoutineRuns(db)
    expect(runs.map((r) => r.routineId)).toEqual(['r2', 'r1'])
    expect(runs[1].error).toBe('boom')
    expect(runs[1].status).toBe('failed')
  })
})

describe('reconcileInterruptedRuns', () => {
  const LATER = new Date('2026-08-03T09:00:00.000Z')

  it('closes out a run stranded by a crash: failed, explanatory error, finished timestamp', () => {
    const id = insertRoutineRun(db, 'nightly-sweep', 'routine-nightly-sweep', 'manual', () => NOW)
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
    const ok = insertRoutineRun(db, 'r-ok', 'routine-r-ok', 'manual', () => NOW)
    finishRoutineRun(db, ok, { status: 'ok', summary: 'all good' }, () => NOW)
    const failed = insertRoutineRun(db, 'r-failed', 'routine-r-failed', 'manual', () => NOW)
    finishRoutineRun(db, failed, { status: 'failed', error: 'boom' }, () => NOW)
    const timeout = insertRoutineRun(db, 'r-timeout', 'routine-r-timeout', 'manual', () => NOW)
    finishRoutineRun(db, timeout, { status: 'timeout', error: 'too slow' }, () => NOW)
    const before = listRoutineRuns(db)

    expect(reconcileInterruptedRuns(db, () => LATER)).toBe(0)

    expect(listRoutineRuns(db)).toEqual(before)
  })

  it('reports the count and reconciles only the stranded rows in a mixed table', () => {
    const done = insertRoutineRun(db, 'r-done', 'routine-r-done', 'manual', () => NOW)
    finishRoutineRun(db, done, { status: 'ok', summary: 'kept' }, () => NOW)
    insertRoutineRun(db, 'r-a', 'routine-r-a', 'manual', () => NOW)
    insertRoutineRun(db, 'r-b', 'routine-r-b', 'manual', () => NOW)

    expect(reconcileInterruptedRuns(db, () => LATER)).toBe(2)

    const byId = new Map(listRoutineRuns(db).map((r) => [r.routineId, r]))
    expect(byId.get('r-a')).toMatchObject({ status: 'failed', error: INTERRUPTED_RUN_ERROR })
    expect(byId.get('r-b')).toMatchObject({ status: 'failed', error: INTERRUPTED_RUN_ERROR })
    expect(byId.get('r-done')).toMatchObject({ status: 'ok', summary: 'kept', error: null })
    expect(listRoutineRuns(db).filter((r) => r.status === 'running')).toEqual([])
  })

  it('is idempotent: a second pass changes nothing and reports 0', () => {
    insertRoutineRun(db, 'r-a', 'routine-r-a', 'manual', () => NOW)
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
    const id = insertRoutineRun(db, 'nightly-sweep', 'routine-nightly-sweep', 'manual', () => NOW)
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
    const id = insertRoutineRun(db, 'r-a', 'routine-r-a', 'manual', () => NOW)
    attachRunSession(db, id, 7)
    expect(runningRoutineForSession(db, 7)).toBe('r-a')
    reconcileInterruptedRuns(db, () => AFTER)
    expect(runningRoutineForSession(db, 7)).toBeNull()
  })

  it('reports the newest run when a session somehow carries more than one', () => {
    const older = insertRoutineRun(db, 'r-a', 'routine-r-a', 'manual', () => NOW)
    attachRunSession(db, older, 9)
    finishRoutineRun(db, older, { status: 'ok' }, () => NOW)
    const newer = insertRoutineRun(db, 'r-b', 'routine-r-b', 'manual', () => NOW)
    attachRunSession(db, newer, 9)
    expect(runningRoutineForSession(db, 9)).toBe('r-b')
  })
})

describe('run trigger', () => {
  it('records and reads back the trigger that started a run', () => {
    const a = insertRoutineRun(db, 'sweep', 'routine-sweep', 'manual')
    const b = insertRoutineRun(db, 'sweep', 'routine-sweep', 'scheduled')
    const c = insertRoutineRun(db, 'sweep', 'routine-sweep', 'catchup')
    const byId = new Map(listRoutineRuns(db).map((r) => [r.id, r.trigger]))
    expect(byId.get(a)).toBe('manual')
    expect(byId.get(b)).toBe('scheduled')
    expect(byId.get(c)).toBe('catchup')
  })

  it('defaults a row written without one to manual', () => {
    // Exactly what the migration leaves behind for every increment-1 run.
    db.prepare(
      `INSERT INTO routine_runs (routine_id, case_slug, status, started_at) VALUES (?, ?, 'ok', ?)`
    ).run('sweep', 'routine-sweep', '2026-08-01T00:00:00.000Z')
    expect(listRoutineRuns(db)[0].trigger).toBe('manual')
  })
})

describe('anchor and watermark', () => {
  const finish = (id: number, status: 'ok' | 'failed', at: string): void =>
    finishRoutineRun(db, id, { status }, () => new Date(at))

  it('returns null for a routine that has never run', () => {
    expect(lastAttemptAt(db, 'sweep')).toBeNull()
    expect(lastSuccessAt(db, 'sweep')).toBeNull()
  })

  it('anchors on the latest attempt whatever its outcome', () => {
    insertRoutineRun(
      db,
      'sweep',
      'routine-sweep',
      'manual',
      () => new Date('2026-08-01T02:00:00.000Z')
    )
    const second = insertRoutineRun(
      db,
      'sweep',
      'routine-sweep',
      'scheduled',
      () => new Date('2026-08-02T02:00:00.000Z')
    )
    finish(second, 'failed', '2026-08-02T02:05:00.000Z')
    // The failed run still moves the anchor. If it did not, the routine would be due again on
    // the very next tick and would retry every 30 seconds, unattended, forever.
    expect(lastAttemptAt(db, 'sweep')).toBe('2026-08-02T02:00:00.000Z')
  })

  it('watermarks only on success', () => {
    const ok = insertRoutineRun(
      db,
      'sweep',
      'routine-sweep',
      'manual',
      () => new Date('2026-08-01T02:00:00.000Z')
    )
    finish(ok, 'ok', '2026-08-01T02:10:00.000Z')
    const bad = insertRoutineRun(
      db,
      'sweep',
      'routine-sweep',
      'scheduled',
      () => new Date('2026-08-02T02:00:00.000Z')
    )
    finish(bad, 'failed', '2026-08-02T02:05:00.000Z')
    // A failed run advanced nothing, so telling the next run "you last succeeded yesterday"
    // would make it skip work that was never done.
    expect(lastSuccessAt(db, 'sweep')).toBe('2026-08-01T02:10:00.000Z')
  })

  it('does not see another routine runs', () => {
    insertRoutineRun(db, 'other', 'routine-other', 'manual')
    expect(lastAttemptAt(db, 'sweep')).toBeNull()
  })

  it('ignores a still-running row for the watermark but not for the anchor', () => {
    insertRoutineRun(
      db,
      'sweep',
      'routine-sweep',
      'scheduled',
      () => new Date('2026-08-03T02:00:00.000Z')
    )
    expect(lastAttemptAt(db, 'sweep')).toBe('2026-08-03T02:00:00.000Z')
    expect(lastSuccessAt(db, 'sweep')).toBeNull()
  })
})

describe('trigger_kind migration', () => {
  it('adds the column to a database created before it existed', () => {
    const older = path.join(home, 'older.db')
    const raw = openDb(older)
    raw.exec(`DROP TABLE routine_runs`)
    raw.exec(`CREATE TABLE routine_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routine_id TEXT NOT NULL,
      case_slug TEXT NOT NULL,
      session_id INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      summary TEXT,
      error TEXT
    )`)
    raw
      .prepare(
        `INSERT INTO routine_runs (routine_id, case_slug, status, started_at) VALUES (?, ?, 'ok', ?)`
      )
      .run('sweep', 'routine-sweep', '2026-08-01T00:00:00.000Z')
    raw.close()

    const migrated = openDb(older)
    expect(listRoutineRuns(migrated)[0].trigger).toBe('manual')
    migrated.close()
  })
})

describe('reviewed_at', () => {
  it('records a finished run as unreviewed', () => {
    const id = insertRoutineRun(db, 'sweep', 'routine-sweep', 'scheduled', () => NOW)
    finishRoutineRun(db, id, { status: 'ok', summary: 'done' }, () => NOW)
    expect(listRoutineRuns(db)[0].reviewedAt).toBeNull()
  })
})

describe('reviewed_at migration', () => {
  it('backfills existing finished rows as reviewed and leaves later runs unreviewed', () => {
    const older = path.join(home, 'older-review.db')
    const raw = openDb(older)
    raw.exec(`DROP TABLE routine_runs`)
    raw.exec(`CREATE TABLE routine_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routine_id TEXT NOT NULL,
      case_slug TEXT NOT NULL,
      session_id INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      summary TEXT,
      error TEXT,
      trigger_kind TEXT NOT NULL DEFAULT 'manual'
    )`)
    raw
      .prepare(
        `INSERT INTO routine_runs (routine_id, case_slug, status, started_at, finished_at)
         VALUES (?, ?, 'ok', ?, ?)`
      )
      .run('sweep', 'routine-sweep', '2026-08-01T00:00:00.000Z', '2026-08-01T00:05:00.000Z')
    raw.close()

    const migrated = openDb(older)
    // Pre-existing history was already visible in Settings; it must not arrive as a wall of
    // unread work the first time the inbox exists.
    expect(listRoutineRuns(migrated)[0].reviewedAt).toBe('2026-08-01T00:05:00.000Z')

    const fresh = insertRoutineRun(migrated, 'sweep', 'routine-sweep', 'scheduled', () => NOW)
    finishRoutineRun(migrated, fresh, { status: 'ok' }, () => NOW)
    expect(listRoutineRuns(migrated)[0].reviewedAt).toBeNull()
    migrated.close()
  })

  it('leaves a stranded running row unreviewed after migration', () => {
    const older = path.join(home, 'older-stranded.db')
    const raw = openDb(older)
    raw.exec(`DROP TABLE routine_runs`)
    raw.exec(`CREATE TABLE routine_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routine_id TEXT NOT NULL,
      case_slug TEXT NOT NULL,
      session_id INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      summary TEXT,
      error TEXT,
      trigger_kind TEXT NOT NULL DEFAULT 'manual'
    )`)
    raw
      .prepare(`INSERT INTO routine_runs (routine_id, case_slug, started_at) VALUES (?, ?, ?)`)
      .run('sweep', 'routine-sweep', '2026-08-01T00:00:00.000Z')
    raw.close()

    // It has no finished_at, so the backfill must skip it. reconcileInterruptedRuns will turn
    // it into a `failed` run at boot, and it SHOULD then land in the inbox — a run the app
    // died in the middle of is exactly what the inbox exists to report.
    const migrated = openDb(older)
    expect(listRoutineRuns(migrated)[0].reviewedAt).toBeNull()
    migrated.close()
  })
})
