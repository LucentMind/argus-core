import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { insertRoutineRun, attachRunSession, finishRoutineRun, listRoutineRuns } from '../runs'

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
