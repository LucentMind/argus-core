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

  it('does not overwrite a human rejection: succeeds, keeps actor, reason and reviewed_at', () => {
    const id = seed('rejected', 'human', 'not what the log says')
    const before = db.prepare(`SELECT * FROM findings WHERE id = ?`).get(id)
    const res = retractFinding(db, id, 'agent wording')
    expect(res).toMatchObject({ ok: true, changed: false })
    expect(db.prepare(`SELECT * FROM findings WHERE id = ?`).get(id)).toEqual(before)
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

  it('actor: human records a human retraction that reviewTag renders as plain rejected', () => {
    const id = seed('pending')
    const r = retractFinding(db, id, 'rewound', { actor: 'human' })
    expect(r.ok).toBe(true)
    const row = db.prepare(`SELECT review_actor, review_reason FROM findings WHERE id = ?`).get(id)
    expect(row).toEqual({ review_actor: 'human', review_reason: 'rewound' })
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

  it('a reset to pending clears review_actor but PRESERVES review_reason', () => {
    // review_reason is the only record of what was wrong with the finding (retractFinding
    // is its sole writer); reviewFinding must never destroy it, only the actor lets it back
    // in through a display/prompt gate. See the comment at the reviewFinding UPDATE.
    const id = seed('rejected', 'agent', 'agent reason')
    reviewFinding(db, id, 'pending')
    const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)
    expect(row?.reviewState).toBe('pending')
    expect(row?.reviewActor).toBeNull()
    expect(row?.reviewReason).toBe('agent reason')
    expect(row?.reviewedAt).toBeNull()
  })

  it('a human reject over an agent retraction replaces the actor but PRESERVES the reason in the DB', () => {
    // Regression guard: a previous wave had reviewFinding clear review_reason on every
    // transition, which meant the most likely human gesture (agreeing with a retraction by
    // clicking reject) permanently destroyed the agent's stated reasoning with no undo. The
    // misattribution that clearing was meant to prevent is handled by actor-gating alone
    // (FindingCard / reviewTag both key off reviewActor === 'agent'), so the DB keeps the
    // text even though it becomes invisible everywhere once the actor is 'human'.
    const id = seed('rejected', 'agent', 'agent reason')
    reviewFinding(db, id, 'rejected')
    const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)
    expect(row?.reviewActor).toBe('human')
    expect(row?.reviewReason).toBe('agent reason')
  })

  it('accepts a finding: actor becomes human and any existing reason survives', () => {
    const id = seed('rejected', 'agent', 'agent reason')
    const reviewed = reviewFinding(db, id, 'accepted')
    expect(reviewed?.reviewState).toBe('accepted')
    expect(reviewed?.reviewActor).toBe('human')
    expect(reviewed?.reviewReason).toBe('agent reason')
    const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)
    expect(row?.reviewState).toBe('accepted')
    expect(row?.reviewActor).toBe('human')
    expect(row?.reviewReason).toBe('agent reason')
  })
})
