import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import {
  listSessions,
  createSession,
  renameSession,
  setTitleIfEmpty,
  sessionCursor,
  deleteSession
} from '../sessionStore'
import { readDeletionAudit } from '../../deletionAudit'

let tmp: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ss-'))
  db = openDb(path.join(tmp, 'argus.db'))
  createCase(db, path.join(tmp, 'home'), { slug: 'NAV-1', title: 't' })
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('sessionStore', () => {
  it('listSessions creates a first session when none exist, then lists newest-first', () => {
    const first = listSessions(db, 'NAV-1')
    expect(first).toHaveLength(1)
    const second = createSession(db, 'NAV-1')
    const list = listSessions(db, 'NAV-1')
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe(second.id) // newest first
  })

  it('setTitleIfEmpty sets once, truncated to 40 chars; rename overwrites; empty rename clears', () => {
    const s = createSession(db, 'NAV-1')
    setTitleIfEmpty(db, s.id, 'x'.repeat(60))
    expect(listSessions(db, 'NAV-1').find((r) => r.id === s.id)!.title).toBe('x'.repeat(40))
    setTitleIfEmpty(db, s.id, 'ignored — already titled')
    expect(listSessions(db, 'NAV-1').find((r) => r.id === s.id)!.title).toBe('x'.repeat(40))
    renameSession(db, s.id, 'Braking RCA')
    expect(listSessions(db, 'NAV-1').find((r) => r.id === s.id)!.title).toBe('Braking RCA')
    renameSession(db, s.id, '   ')
    expect(listSessions(db, 'NAV-1').find((r) => r.id === s.id)!.title).toBe('')
  })

  it('sessionCursor returns the per-session sdk id', () => {
    const s = createSession(db, 'NAV-1')
    db.prepare(`UPDATE sessions SET sdk_session_id = 'uuid-x' WHERE id = ?`).run(s.id)
    expect(sessionCursor(db, s.id)).toBe('uuid-x')
    expect(sessionCursor(db, 999999)).toBeNull()
  })

  it('listSessions throws for an unknown case', () => {
    expect(() => listSessions(db, 'NOPE')).toThrow(/unknown case/i)
  })

  it('deleteSession removes turns/tool_calls/messages_fts rows, the sessions row, and the jsonl mirror; audits', () => {
    const argusHome = path.join(tmp, 'home')
    const s = createSession(db, 'NAV-1')
    const keep = createSession(db, 'NAV-1')
    const now = new Date().toISOString()
    const caseId = 1
    db.prepare(
      `INSERT INTO turns (case_id, session_id, turn_index, status, created_at) VALUES (?, ?, 0, 'done', ?)`
    ).run(caseId, s.id, now)
    db.prepare(
      `INSERT INTO tool_calls (case_id, session_id, tool, args_hash, risk, decision, created_at)
       VALUES (?, ?, 'Read', 'h', 'low', 'allow', ?)`
    ).run(caseId, s.id, now)
    db.prepare(
      `INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES ('hello', ?, ?, 1, 'user')`
    ).run(caseId, s.id)
    db.prepare(
      `INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES ('other', ?, ?, 1, 'user')`
    ).run(caseId, keep.id)
    const jsonl = path.join(argusHome, 'cases', 'NAV-1', 'sessions', `${s.id}.jsonl`)
    fs.mkdirSync(path.dirname(jsonl), { recursive: true })
    fs.writeFileSync(jsonl, '{"type":"x"}\n')

    deleteSession(db, argusHome, 'NAV-1', s.id)

    const n = (sql: string): number => Number((db.prepare(sql).get(s.id) as { n: number }).n)
    expect(n(`SELECT COUNT(*) AS n FROM sessions WHERE id = ?`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM turns WHERE session_id = ?`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM messages_fts WHERE session_id = ?`)).toBe(0)
    expect(
      Number(
        (
          db
            .prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE session_id = ?`)
            .get(keep.id) as { n: number }
        ).n
      )
    ).toBe(1) // the other chat's index survives
    expect(fs.existsSync(jsonl)).toBe(false)
    const audit = readDeletionAudit(argusHome)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ op: 'session.delete', caseSlug: 'NAV-1' })
    expect(audit[0].detail).toMatchObject({ sessionId: s.id })
  })

  it('deleting the last session is allowed — listSessions then auto-creates a fresh one', () => {
    const argusHome = path.join(tmp, 'home')
    const only = listSessions(db, 'NAV-1')[0]
    deleteSession(db, argusHome, 'NAV-1', only.id)
    const after = listSessions(db, 'NAV-1')
    expect(after).toHaveLength(1)
    expect(after[0].id).not.toBe(only.id)
  })

  it('deleteSession rejects a session belonging to another case and non-integer ids', () => {
    const argusHome = path.join(tmp, 'home')
    createCase(db, argusHome, { slug: 'NAV-2', title: 't2' })
    const foreign = createSession(db, 'NAV-2')
    expect(() => deleteSession(db, argusHome, 'NAV-1', foreign.id)).toThrow(/unknown session/i)
    expect(() => deleteSession(db, argusHome, 'NAV-1', 1.5)).toThrow(/invalid session id/i)
    expect(listSessions(db, 'NAV-2')[0].id).toBe(foreign.id) // untouched
  })
})
