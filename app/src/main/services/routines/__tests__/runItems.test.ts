import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { insertRoutineRun } from '../runs'
import {
  insertRunItem,
  attachItemCase,
  finishRunItem,
  saveItemSuggestion,
  getRunItem,
  listRunItems,
  attemptedItemKeys,
  runItemForCase
} from '../runItems'

let tmp: string
let db: DatabaseSync
const at = (iso: string) => () => new Date(iso)

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runitems-'))
  db = openDb(path.join(tmp, 'a.sqlite'))
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const newRun = (routineId = 'nightly'): number =>
  insertRoutineRun(db, routineId, `routine-${routineId}`, 'scheduled', at('2026-08-08T02:00:00.000Z'))

describe('run items', () => {
  it('opens an item as running before any work happens', () => {
    const runId = newRun()
    const id = insertRunItem(db, runId, 'ABC-1', at('2026-08-08T02:00:01.000Z'))
    const item = getRunItem(db, id)!
    expect(item.status).toBe('running')
    expect(item.itemKey).toBe('ABC-1')
    expect(item.caseSlug).toBeNull()
    expect(item.finishedAt).toBeNull()
  })

  it('binds the case once it exists', () => {
    const id = insertRunItem(db, newRun(), 'ABC-1', at('2026-08-08T02:00:01.000Z'))
    attachItemCase(db, id, 'abc-1')
    expect(getRunItem(db, id)!.caseSlug).toBe('abc-1')
  })

  it('records a failure with its text', () => {
    const id = insertRunItem(db, newRun(), 'ABC-1', at('2026-08-08T02:00:01.000Z'))
    finishRunItem(db, id, { status: 'failed', error: 'attachment 404' }, at('2026-08-08T02:01:00.000Z'))
    const item = getRunItem(db, id)!
    expect(item.status).toBe('failed')
    expect(item.error).toBe('attachment 404')
    expect(item.finishedAt).toBe('2026-08-08T02:01:00.000Z')
  })

  it('round-trips a suggestion as structured data, not prose', () => {
    const id = insertRunItem(db, newRun(), 'ABC-1', at('2026-08-08T02:00:01.000Z'))
    saveItemSuggestion(db, id, {
      title: 'Crash on empty payload',
      tags: ['severity:high', 'component:auth'],
      rationale: 'stack trace matches ABC-9'
    })
    expect(getRunItem(db, id)!.suggestion).toEqual({
      title: 'Crash on empty payload',
      tags: ['severity:high', 'component:auth'],
      rationale: 'stack trace matches ABC-9'
    })
  })

  it('survives a corrupt suggestion blob rather than throwing on read', () => {
    const id = insertRunItem(db, newRun(), 'ABC-1', at('2026-08-08T02:00:01.000Z'))
    db.prepare(`UPDATE routine_run_items SET suggestion = '{not json' WHERE id = ?`).run(id)
    expect(getRunItem(db, id)!.suggestion).toBeNull()
  })

  it('lists items for several runs at once, oldest item first', () => {
    const r1 = newRun('a')
    const r2 = newRun('b')
    insertRunItem(db, r1, 'A-1', at('2026-08-08T02:00:01.000Z'))
    insertRunItem(db, r2, 'B-1', at('2026-08-08T02:00:02.000Z'))
    insertRunItem(db, r1, 'A-2', at('2026-08-08T02:00:03.000Z'))
    expect(listRunItems(db, [r1, r2]).map((i) => i.itemKey)).toEqual(['A-1', 'B-1', 'A-2'])
  })

  it('returns no items for an empty run list without building a broken SQL IN ()', () => {
    expect(listRunItems(db, [])).toEqual([])
  })

  it('reports every key this routine has ATTEMPTED, across all of its runs', () => {
    const r1 = newRun('nightly')
    insertRunItem(db, r1, 'ABC-1', at('2026-08-08T02:00:01.000Z'))
    const r2 = newRun('nightly')
    insertRunItem(db, r2, 'ABC-2', at('2026-08-09T02:00:01.000Z'))
    const other = newRun('weekly')
    insertRunItem(db, other, 'ZZZ-9', at('2026-08-09T03:00:01.000Z'))

    const keys = attemptedItemKeys(db, 'nightly')
    expect([...keys].sort()).toEqual(['ABC-1', 'ABC-2'])
    // Another routine's keys must not suppress this one's work.
    expect(keys.has('ZZZ-9')).toBe(false)
  })

  it('finds the newest item row for a case, which is what accept/dismiss acts on', () => {
    const id1 = insertRunItem(db, newRun(), 'ABC-1', at('2026-08-08T02:00:01.000Z'))
    attachItemCase(db, id1, 'abc-1')
    const id2 = insertRunItem(db, newRun(), 'ABC-1', at('2026-08-09T02:00:01.000Z'))
    attachItemCase(db, id2, 'abc-1')
    expect(runItemForCase(db, 'abc-1')!.id).toBe(id2)
  })
})
