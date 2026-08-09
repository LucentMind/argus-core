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
  INTERRUPTED_RUN_ERROR,
  markRunReviewed,
  markAllRunsReviewed,
  countUnreviewedRuns
} from '../runs'
import { insertRunItem, finishRunItem, getRunItem, attachItemCase } from '../runItems'
import { createCase } from '../../caseService'

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

  // Finding 1: reconcileInterruptedRuns only healed routine_runs, leaving a stranded item row
  // (opened by a crash mid-turn) at status='running', finished_at=NULL forever — payload().runItems
  // hands that row to the UI indefinitely, exactly the defect this function exists to close for
  // the run row it belongs to.
  it('closes out a stranded ITEM row the same way it closes its run: failed, error, finished_at', () => {
    const runId = insertRoutineRun(db, 'nightly-sweep', null, 'scheduled', () => NOW)
    const itemId = insertRunItem(db, runId, 'ABC-1', () => NOW)
    expect(getRunItem(db, itemId)).toMatchObject({ status: 'running', finishedAt: null })

    reconcileInterruptedRuns(db, () => LATER)

    expect(getRunItem(db, itemId)).toMatchObject({
      status: 'failed',
      error: INTERRUPTED_RUN_ERROR,
      finishedAt: LATER.toISOString(),
      // Untouched: which item and case this row was working is still the useful part of it.
      itemKey: 'ABC-1'
    })
  })

  it('is idempotent for item rows too: a second pass changes nothing', () => {
    const runId = insertRoutineRun(db, 'nightly-sweep', null, 'scheduled', () => NOW)
    const itemId = insertRunItem(db, runId, 'ABC-1', () => NOW)
    reconcileInterruptedRuns(db, () => LATER)
    const afterFirst = getRunItem(db, itemId)

    // A later `now` would be visible in finishedAt if the second pass rewrote the row.
    reconcileInterruptedRuns(db, () => new Date('2026-08-04T00:00:00.000Z'))

    expect(getRunItem(db, itemId)).toEqual(afterFirst)
  })

  it('leaves an item row that already finished exactly as it was', () => {
    const runId = insertRoutineRun(db, 'nightly-sweep', null, 'scheduled', () => NOW)
    const itemId = insertRunItem(db, runId, 'ABC-1', () => NOW)
    finishRunItem(db, itemId, { status: 'processed' }, () => NOW)
    const before = getRunItem(db, itemId)

    reconcileInterruptedRuns(db, () => LATER)

    expect(getRunItem(db, itemId)).toEqual(before)
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

    // The column guard is what makes the backfill one-time. Without it, every launch would
    // mark every finished run reviewed and the inbox would be permanently empty.
    const reopened = openDb(older)
    expect(listRoutineRuns(reopened)[0].reviewedAt).toBeNull()
    reopened.close()
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

describe('marking runs reviewed', () => {
  const finished = (routineId: string, at = NOW): number => {
    const id = insertRoutineRun(db, routineId, `routine-${routineId}`, 'scheduled', () => at)
    finishRoutineRun(db, id, { status: 'ok', summary: 'done' }, () => at)
    return id
  }

  it('marks one run and drops it out of the count', () => {
    const a = finished('a')
    finished('b')
    expect(countUnreviewedRuns(db)).toBe(2)

    markRunReviewed(db, a, () => NOW)

    expect(countUnreviewedRuns(db)).toBe(1)
    expect(listRoutineRuns(db).find((r) => r.id === a)?.reviewedAt).toBe(NOW.toISOString())
  })

  it('never marks a run that is still running', () => {
    // A run can finish between a payload render and the click that lands on it. The guard is in
    // the SQL rather than the renderer so the renderer cannot lose that race.
    const live = insertRoutineRun(db, 'live', 'routine-live', 'scheduled', () => NOW)
    markRunReviewed(db, live, () => NOW)
    expect(listRoutineRuns(db)[0].reviewedAt).toBeNull()
    // And it is not counted as unreviewed either — it is not a result yet.
    expect(countUnreviewedRuns(db)).toBe(0)
  })

  it('does not move the timestamp when a run is marked twice', () => {
    const a = finished('a')
    const later = new Date('2026-08-04T09:00:00.000Z')
    markRunReviewed(db, a, () => NOW)
    markRunReviewed(db, a, () => later)
    expect(listRoutineRuns(db)[0].reviewedAt).toBe(NOW.toISOString())
  })

  it('marks all finished unreviewed runs and reports how many', () => {
    finished('a')
    finished('b')
    insertRoutineRun(db, 'live', 'routine-live', 'scheduled', () => NOW)

    expect(markAllRunsReviewed(db, () => NOW)).toBe(2)
    expect(countUnreviewedRuns(db)).toBe(0)
    // The in-flight run is untouched, so it enters the inbox when it finishes.
    expect(listRoutineRuns(db).find((r) => r.routineId === 'live')?.reviewedAt).toBeNull()
  })

  it('counts beyond the 50-row list window', () => {
    // listRoutineRuns caps at 50, so a count derived from it would under-report exactly when
    // the number matters most.
    for (let i = 0; i < 55; i++) finished(`r${i}`)
    expect(listRoutineRuns(db)).toHaveLength(50)
    expect(countUnreviewedRuns(db)).toBe(55)
    expect(markAllRunsReviewed(db, () => NOW)).toBe(55)
  })

  /**
   * Marking a run reviewed hides it from the Home inbox, which is the ONLY accept/dismiss
   * surface there is. Before this guard, doing so left every one of that run's draft cases at
   * `review_state = 'draft'` forever — permanent Draft badge, suggestion unappliable, and
   * permanently excluded from every `cases`-scoped routine — with no surface left to fix it on.
   */
  describe('with items still awaiting accept or dismiss', () => {
    /** A finished run with one item bound to a real case in the given review/lifecycle state. */
    const runWithItem = (
      routineId: string,
      state: { reviewState: 'draft' | null; status?: 'open' | 'closed' }
    ): number => {
      const runId = finished(routineId)
      const slug = `case-${routineId}`
      createCase(db, home, { slug, title: slug })
      db.prepare(`UPDATE cases SET review_state = ?, status = ? WHERE slug = ?`).run(
        state.reviewState,
        state.status ?? 'open',
        slug
      )
      const itemId = insertRunItem(db, runId, `KEY-${routineId}`, () => NOW)
      attachItemCase(db, itemId, slug)
      finishRunItem(db, itemId, { status: 'processed' }, () => NOW)
      return runId
    }

    it('refuses to mark the run reviewed, naming how many are left', () => {
      const runId = runWithItem('drafty', { reviewState: 'draft' })
      expect(() => markRunReviewed(db, runId, () => NOW)).toThrow(/1 draft item to accept/)
      expect(listRoutineRuns(db)[0].reviewedAt).toBeNull()
      expect(countUnreviewedRuns(db)).toBe(1)
    })

    it('pluralizes the count over several un-actioned items', () => {
      const runId = finished('many')
      for (const n of [1, 2, 3]) {
        const slug = `many-${n}`
        createCase(db, home, { slug, title: slug })
        db.prepare(`UPDATE cases SET review_state = 'draft' WHERE slug = ?`).run(slug)
        const itemId = insertRunItem(db, runId, `KEY-${n}`, () => NOW)
        attachItemCase(db, itemId, slug)
        finishRunItem(db, itemId, { status: 'processed' }, () => NOW)
      }
      expect(() => markRunReviewed(db, runId, () => NOW)).toThrow(/3 draft items to accept/)
    })

    it('marks fine once every item has been accepted', () => {
      // Accept is `review_state -> null` (service.ts's acceptItem).
      const runId = runWithItem('accepted', { reviewState: null })
      markRunReviewed(db, runId, () => NOW)
      expect(listRoutineRuns(db)[0].reviewedAt).toBe(NOW.toISOString())
    })

    it('marks fine once every item has been dismissed', () => {
      // Dismiss CLOSES the case and deliberately leaves review_state set, so a review_state
      // check on its own would keep refusing forever — the whole strand this guard prevents,
      // reintroduced by the guard itself.
      const runId = runWithItem('dismissed', { reviewState: 'draft', status: 'closed' })
      markRunReviewed(db, runId, () => NOW)
      expect(listRoutineRuns(db)[0].reviewedAt).toBe(NOW.toISOString())
    })

    it('leaves a run with no items at all completely unaffected', () => {
      // Every routine shipped in increments 1-3 is this shape. A regression here would make the
      // inbox unclearable for users who have no scoped routines at all.
      const runId = finished('unscoped')
      markRunReviewed(db, runId, () => NOW)
      expect(listRoutineRuns(db)[0].reviewedAt).toBe(NOW.toISOString())
    })

    it('does not block on an item whose ingest never produced a case', () => {
      // case_slug stays NULL when ingest threw. Nothing can ever action such an item, so
      // blocking on it would be a permanent inbox lock.
      const runId = finished('no-case')
      const itemId = insertRunItem(db, runId, 'KEY-X', () => NOW)
      finishRunItem(db, itemId, { status: 'failed', error: 'ingest failed' }, () => NOW)
      markRunReviewed(db, runId, () => NOW)
      expect(listRoutineRuns(db)[0].reviewedAt).toBe(NOW.toISOString())
    })

    it('refuses "mark all" for the same reason, and writes nothing at all', () => {
      // All-or-nothing: main only broadcasts routines:changed after a SUCCESSFUL write, so
      // clearing the clean runs and then throwing would leave every window rendering rows that
      // had in fact just been cleared.
      const clean = finished('clean')
      runWithItem('drafty', { reviewState: 'draft' })
      expect(() => markAllRunsReviewed(db, () => NOW)).toThrow(/1 draft item in 1 run still need/)
      expect(listRoutineRuns(db).find((r) => r.id === clean)?.reviewedAt).toBeNull()
      expect(countUnreviewedRuns(db)).toBe(2)
    })

    it('clears everything once the drafts are actioned', () => {
      finished('clean')
      const runId = runWithItem('drafty', { reviewState: 'draft' })
      expect(() => markAllRunsReviewed(db, () => NOW)).toThrow()
      db.prepare(`UPDATE cases SET review_state = NULL WHERE slug = 'case-drafty'`).run()
      expect(markAllRunsReviewed(db, () => NOW)).toBe(2)
      expect(countUnreviewedRuns(db)).toBe(0)
      expect(runId).toBeGreaterThan(0)
    })

    it('ignores drafts belonging to a run that is already reviewed', () => {
      // The rule governs marks that would otherwise take effect. A run already out of the inbox
      // cannot be re-marked anyway, and counting it would lock the inbox on history.
      const stale = runWithItem('stale', { reviewState: 'draft' })
      db.prepare(`UPDATE routine_runs SET reviewed_at = ? WHERE id = ?`).run(
        NOW.toISOString(),
        stale
      )
      const clean = finished('clean')
      expect(markAllRunsReviewed(db, () => NOW)).toBe(1)
      expect(listRoutineRuns(db).find((r) => r.id === clean)?.reviewedAt).toBe(NOW.toISOString())
    })
  })
})
