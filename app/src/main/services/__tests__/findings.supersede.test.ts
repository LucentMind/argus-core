import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { SUPERSEDED_REASON, canSupersede, listFindings, supersedeFinding } from '../findings'

let home: string
let db: DatabaseSync
let caseId: number
let otherCaseId: number

function seed(extra: Record<string, string | number | null> = {}, cid = caseId): number {
  const now = new Date().toISOString()
  const base: Record<string, string | number | null> = {
    case_id: cid,
    session_id: null,
    summary: 'Race in parser',
    review_state: 'pending',
    created_at: now,
    ...extra
  }
  const cols = Object.keys(base)
  return Number(
    db
      .prepare(
        `INSERT INTO findings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      )
      .run(...Object.values(base)).lastInsertRowid
  )
}
const col = (id: number, name: string): unknown =>
  (db.prepare(`SELECT ${name} AS v FROM findings WHERE id = ?`).get(id) as { v: unknown }).v

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-supersede-'))
  db = openDb(path.join(home, 'argus.db'))
  caseId = createCase(db, home, { slug: 'CASE-A', title: 'A' }).id
  otherCaseId = createCase(db, home, { slug: 'CASE-B', title: 'B' }).id
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('canSupersede', () => {
  it('refuses an unknown or cross-case id, an accepted finding and one already superseded', () => {
    expect(canSupersede(db, caseId, 999)).toEqual({ ok: false, reason: 'unknown' })
    expect(canSupersede(db, caseId, seed({}, otherCaseId))).toEqual({
      ok: false,
      reason: 'unknown'
    })
    expect(canSupersede(db, caseId, seed({ review_state: 'accepted' }))).toEqual({
      ok: false,
      reason: 'accepted'
    })
    expect(canSupersede(db, caseId, seed({ superseded_by: 1 }))).toEqual({
      ok: false,
      reason: 'already-superseded'
    })
    expect(canSupersede(db, caseId, seed())).toEqual({ ok: true })
  })
})

describe('supersedeFinding', () => {
  it('retracts the old finding as superseded, links it, and re-parents its children', () => {
    const old = seed()
    const child = seed({ caused_by: old })
    const unrelated = seed({ caused_by: child })
    const fresh = seed()
    const res = supersedeFinding(db, old, fresh)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.retracted).toBe(true)
    expect(res.row.supersededBy).toBe(fresh)
    expect(res.row.reviewState).toBe('rejected')
    expect(res.row.reviewActor).toBe('agent')
    expect(res.row.reviewReason).toBe(SUPERSEDED_REASON(fresh))
    expect(col(child, 'caused_by')).toBe(fresh)
    expect(col(unrelated, 'caused_by')).toBe(child)
    expect(listFindings(db, home, 'CASE-A').find((f) => f.id === old)?.supersededBy).toBe(fresh)
  })

  it("keeps a human's rejection but still links and re-parents", () => {
    const old = seed({ review_state: 'rejected', review_actor: 'human', reject_tag: 'wrong' })
    const child = seed({ caused_by: old })
    const fresh = seed()
    const res = supersedeFinding(db, old, fresh)
    expect(res.ok && res.retracted).toBe(false)
    expect(col(old, 'reject_tag')).toBe('wrong')
    expect(col(old, 'review_reason')).toBeNull()
    expect(col(old, 'superseded_by')).toBe(fresh)
    expect(col(child, 'caused_by')).toBe(fresh)
  })

  it('refuses before writing when the old finding is accepted or in another case', () => {
    const acc = seed({ review_state: 'accepted' })
    const child = seed({ caused_by: acc })
    const fresh = seed()
    expect(supersedeFinding(db, acc, fresh)).toEqual({ ok: false, reason: 'accepted' })
    expect(col(child, 'caused_by')).toBe(acc)
    expect(supersedeFinding(db, seed({}, otherCaseId), fresh)).toEqual({
      ok: false,
      reason: 'unknown'
    })
  })
})
