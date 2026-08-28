import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { caseHasLiveWork } from '../caseLiveWork'
import { insertRoutineRun, finishRoutineRun } from '../routines/runs'
import { insertRunItem, attachItemCase, finishRunItem } from '../routines/runItems'

/**
 * The seam `main/index.ts` binds to `ArchiveDeps.hasLiveWork`. Tested here rather than through
 * the IPC handler because that handler is registered inline inside `registerIpc()`, and
 * `main/index.ts` imports `electron` at module scope so it cannot be imported into Vitest at all
 * (see main/__tests__/routinesIpc.test.ts, which reads it as source text for the same reason).
 * The handler-side wiring is pinned as source text in main/__tests__/caseArchiveIpc.test.ts;
 * the DECISION lives here, where it can be exercised for real.
 */
const opened: Array<{ db: DatabaseSync; home: string }> = []

function freshDb(): DatabaseSync {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-livework-')))
  const db = openDb(path.join(home, 'argus.db'))
  opened.push({ db, home })
  return db
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

const idle = { liveCaseSlugs: (): string[] => [] }

describe('caseHasLiveWork', () => {
  it('is false for a case with no chats and no routine runs', () => {
    expect(caseHasLiveWork(freshDb(), 'KAN-1', idle)).toBe(false)
  })

  it('is true while a foreground agent session is live for that case', () => {
    const db = freshDb()
    const deps = { liveCaseSlugs: () => ['KAN-1', 'KAN-9'] }
    expect(caseHasLiveWork(db, 'KAN-1', deps)).toBe(true)
    // and scoped to the slug asked about, not "any case is busy"
    expect(caseHasLiveWork(db, 'KAN-2', deps)).toBe(false)
  })

  it('is true while an UNSCOPED routine run owns that case, which the session map cannot see', () => {
    const db = freshDb()
    // Exactly what RoutinesService.execute writes for an unscoped routine: the run row records
    // the `routine-<id>` case it opens. No entry is ever made in AgentService's live map for
    // that background session, so `liveCaseSlugs` stays empty throughout.
    const runId = insertRoutineRun(db, 'daily-triage', 'routine-daily-triage', 'scheduled')
    expect(caseHasLiveWork(db, 'routine-daily-triage', idle)).toBe(true)

    finishRoutineRun(db, runId, { status: 'ok' })
    expect(caseHasLiveWork(db, 'routine-daily-triage', idle)).toBe(false)
  })

  it('is true while a SCOPED run is working that case, whose slug lives only on the item row', () => {
    const db = freshDb()
    // A scoped run writes NULL to routine_runs.case_slug and records each item's case on
    // routine_run_items — so a check that consulted only routine_runs would miss every scoped
    // run, which is the common shape.
    const runId = insertRoutineRun(db, 'jql-sweep', null, 'scheduled')
    const itemId = insertRunItem(db, runId, 'KAN-7')
    attachItemCase(db, itemId, 'KAN-7')

    expect(caseHasLiveWork(db, 'KAN-7', idle)).toBe(true)
    // a sibling case named by no item row is unaffected
    expect(caseHasLiveWork(db, 'KAN-8', idle)).toBe(false)

    finishRunItem(db, itemId, { status: 'processed' })
    expect(caseHasLiveWork(db, 'KAN-7', idle)).toBe(false)
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
    expect(caseHasLiveWork(db, 'KAN-1', idle)).toBe(false)
    expect(caseHasLiveWork(db, 'KAN-2', idle)).toBe(true)
  })

  it('ignores a run left `running` by a crash once boot reconciliation has closed it', () => {
    const db = freshDb()
    const runId = insertRoutineRun(db, 'daily-triage', 'routine-daily-triage', 'manual')
    finishRoutineRun(db, runId, { status: 'failed', error: 'interrupted' })
    expect(caseHasLiveWork(db, 'routine-daily-triage', idle)).toBe(false)
  })
})
