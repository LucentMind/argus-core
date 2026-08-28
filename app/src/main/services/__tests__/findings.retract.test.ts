import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { retractFinding, reviewFinding, listFindings } from '../findings'

let home: string
let db: DatabaseSync
let caseId: number

function seed(state: 'pending' | 'accepted' | 'rejected', actor?: string, reason?: string): number {
  const now = new Date().toISOString()
  const res = db
    .prepare(
      `INSERT INTO findings (case_id, session_id, summary, review_state, created_at, review_actor, review_reason)
       VALUES (?, NULL, 'Race in parser', ?, ?, ?, ?)`
    )
    .run(caseId, state, now, actor ?? null, reason ?? null)
  return Number(res.lastInsertRowid)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-retract-'))
  db = openDb(path.join(home, 'argus.db'))
  caseId = createCase(db, home, { slug: 'CASE-A', title: 'A' }).id
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('retractFinding', () => {
  it('adds review_reason and review_actor as nullable columns', () => {
    const cols = (db.prepare(`PRAGMA table_info(findings)`).all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols).toEqual(expect.arrayContaining(['review_reason', 'review_actor']))
  })

  it('reads a pre-existing row back with both fields null', () => {
    const id = seed('pending')
    const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)
    expect(row?.reviewReason).toBeNull()
    expect(row?.reviewActor).toBeNull()
  })

  it('retracts a pending finding as the agent, with the reason and a timestamp', () => {
    const id = seed('pending')
    const res = retractFinding(db, id, 'the guard is in the caller, not here')
    expect(res).toMatchObject({ ok: true, changed: true })
    const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)
    expect(row?.reviewState).toBe('rejected')
    expect(row?.reviewActor).toBe('agent')
    expect(row?.reviewReason).toBe('the guard is in the caller, not here')
    expect(row?.reviewedAt).not.toBeNull()
  })

  it('REFUSES an accepted finding and leaves every column untouched', () => {
    const id = seed('accepted')
    const before = db.prepare(`SELECT * FROM findings WHERE id = ?`).get(id)
    const res = retractFinding(db, id, 'I changed my mind')
    expect(res).toEqual({ ok: false, reason: 'accepted' })
    expect(db.prepare(`SELECT * FROM findings WHERE id = ?`).get(id)).toEqual(before)
  })

  it('does not overwrite a human rejection: succeeds, keeps actor and reason', () => {
    const id = seed('rejected', 'human', 'not what the log says')
    const res = retractFinding(db, id, 'agent wording')
    expect(res).toMatchObject({ ok: true, changed: false })
    const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)
    expect(row?.reviewActor).toBe('human')
    expect(row?.reviewReason).toBe('not what the log says')
  })

  it('overwrites its own earlier retraction with the newer reason', () => {
    const id = seed('rejected', 'agent', 'first reason')
    retractFinding(db, id, 'second reason')
    const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)
    expect(row?.reviewReason).toBe('second reason')
    expect(row?.reviewActor).toBe('agent')
  })

  it('reports an unknown id rather than throwing', () => {
    expect(retractFinding(db, 9999, 'nope')).toEqual({ ok: false, reason: 'unknown' })
  })
})

describe('reviewFinding', () => {
  it('stamps the human actor', () => {
    const id = seed('pending')
    reviewFinding(db, id, 'rejected')
    const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)
    expect(row?.reviewActor).toBe('human')
  })
})
