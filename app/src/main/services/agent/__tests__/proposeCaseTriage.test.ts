import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createDetection } from '../../packs/detection'
import { insertRoutineRun } from '../../routines/runs'
import { insertRunItem, getRunItem } from '../../routines/runItems'
import { argusToolHandlers } from '../nativeTools'

let tmp: string
let db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-tool-'))
  db = openDb(path.join(tmp, 'a.sqlite'))
  createCase(db, tmp, { slug: 'abc-1', title: 'ABC-1' })
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const makeItem = (): number =>
  insertRunItem(db, insertRoutineRun(db, 'nightly', 'routine-nightly', 'scheduled'), 'ABC-1')

const tools = (
  currentRunItemId: () => number | null
): Record<string, (args: Record<string, unknown>) => Promise<string>> =>
  argusToolHandlers({
    db,
    argusHome: tmp,
    detection: createDetection(),
    caseId: 1,
    caseSlug: 'abc-1',
    sessionId: 1,
    emitFinding: () => {},
    currentRunItemId
  })

describe('propose_case_triage', () => {
  it('stores the proposal on the item row', async () => {
    const itemId = makeItem()
    await tools(() => itemId).propose_case_triage({
      title: 'Crash on empty payload',
      tags: ['severity:high'],
      rationale: 'stack trace matches ABC-9'
    })
    expect(getRunItem(db, itemId)!.suggestion).toEqual({
      title: 'Crash on empty payload',
      tags: ['severity:high'],
      rationale: 'stack trace matches ABC-9'
    })
  })

  it('DOES NOT touch the case — that is the whole point of it being a suggestion', async () => {
    const itemId = makeItem()
    await tools(() => itemId).propose_case_triage({
      title: 'Crash on empty payload',
      tags: ['severity:high'],
      rationale: 'because'
    })
    const kase = db.prepare(`SELECT title, tags FROM cases WHERE slug = 'abc-1'`).get() as {
      title: string
      tags: string
    }
    expect(kase.title).toBe('ABC-1')
    expect(kase.tags).toBe('[]')
  })

  it('refuses outside an item run rather than silently discarding the proposal', async () => {
    const res = await tools(() => null).propose_case_triage({ rationale: 'because' })
    expect(res).toMatch(/not processing an item/i)
    // Nothing written anywhere.
    const n = db.prepare(`SELECT COUNT(*) AS n FROM routine_run_items`).get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('overwrites an earlier proposal for the same item, so the last word wins', async () => {
    const itemId = makeItem()
    const t = tools(() => itemId)
    await t.propose_case_triage({ title: 'first', rationale: 'a' })
    await t.propose_case_triage({ title: 'second', rationale: 'b' })
    expect(getRunItem(db, itemId)!.suggestion!.title).toBe('second')
  })
})
