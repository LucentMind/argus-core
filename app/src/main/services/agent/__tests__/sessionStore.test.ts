import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { insertMessageFts } from '../../ftsIndex'
import {
  listSessions,
  createSession,
  renameSession,
  setTitleIfEmpty,
  sessionCursor,
  sessionProvider,
  setSessionModel,
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
    const second = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const list = listSessions(db, 'NAV-1')
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe(second.id) // newest first
  })

  it('listSessions and createSession surface driverKind on the returned summary', () => {
    const claudeS = createSession(db, 'NAV-1', 'claude-agent-sdk')
    expect(claudeS.driverKind).toBe('claude-agent-sdk')
    const copilotS = createSession(db, 'NAV-1', 'github-copilot')
    expect(copilotS.driverKind).toBe('github-copilot')

    const list = listSessions(db, 'NAV-1')
    expect(list.find((s) => s.id === claudeS.id)!.driverKind).toBe('claude-agent-sdk')
    expect(list.find((s) => s.id === copilotS.id)!.driverKind).toBe('github-copilot')
  })

  it('setTitleIfEmpty sets once, truncated to 40 chars; rename overwrites; empty rename clears', () => {
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
    setTitleIfEmpty(db, s.id, 'x'.repeat(60))
    expect(listSessions(db, 'NAV-1').find((r) => r.id === s.id)!.title).toBe('x'.repeat(40))
    setTitleIfEmpty(db, s.id, 'ignored — already titled')
    expect(listSessions(db, 'NAV-1').find((r) => r.id === s.id)!.title).toBe('x'.repeat(40))
    renameSession(db, s.id, 'Braking RCA')
    expect(listSessions(db, 'NAV-1').find((r) => r.id === s.id)!.title).toBe('Braking RCA')
    renameSession(db, s.id, '   ')
    expect(listSessions(db, 'NAV-1').find((r) => r.id === s.id)!.title).toBe('')
  })

  it('createSession stamps driver_kind at creation, per the driverKind argument', () => {
    const claudeS = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const row1 = db.prepare(`SELECT driver_kind FROM sessions WHERE id = ?`).get(claudeS.id) as {
      driver_kind: string
    }
    expect(row1.driver_kind).toBe('claude-agent-sdk')

    const copilotS = createSession(db, 'NAV-1', 'github-copilot')
    const row2 = db.prepare(`SELECT driver_kind FROM sessions WHERE id = ?`).get(copilotS.id) as {
      driver_kind: string
    }
    expect(row2.driver_kind).toBe('github-copilot')
  })

  it('listSessions auto-create defaults driver_kind to claude-agent-sdk, but honors an explicit driverKind', () => {
    const s1 = listSessions(db, 'NAV-1')[0]
    const row1 = db.prepare(`SELECT driver_kind FROM sessions WHERE id = ?`).get(s1.id) as {
      driver_kind: string
    }
    expect(row1.driver_kind).toBe('claude-agent-sdk')

    createCase(db, path.join(tmp, 'home'), { slug: 'NAV-3', title: 't3' })
    const s2 = listSessions(db, 'NAV-3', 'github-copilot')[0]
    const row2 = db.prepare(`SELECT driver_kind FROM sessions WHERE id = ?`).get(s2.id) as {
      driver_kind: string
    }
    expect(row2.driver_kind).toBe('github-copilot')
  })

  it('sessionCursor returns the per-session cursor when the driver kind matches', () => {
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
    db.prepare(`UPDATE sessions SET driver_cursor = 'uuid-x' WHERE id = ?`).run(s.id)
    expect(sessionCursor(db, s.id, 'claude-agent-sdk')).toBe('uuid-x')
    expect(sessionCursor(db, 999999, 'claude-agent-sdk')).toBeNull()
  })

  it('sessionCursor returns null on driver-kind mismatch', () => {
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
    db.prepare(`UPDATE sessions SET driver_cursor = 'uuid-x' WHERE id = ?`).run(s.id)
    expect(sessionCursor(db, s.id, 'claude-agent-sdk')).toBe('uuid-x')
    expect(sessionCursor(db, s.id, 'github-copilot')).toBeNull()
  })

  it('listSessions throws for an unknown case', () => {
    expect(() => listSessions(db, 'NOPE')).toThrow(/unknown case/i)
  })

  it('deleteSession removes turns/tool_calls/messages_fts rows, the sessions row, and the jsonl mirror; audits', () => {
    const argusHome = path.join(tmp, 'home')
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const keep = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const now = new Date().toISOString()
    const caseId = 1
    db.prepare(
      `INSERT INTO turns (case_id, session_id, turn_index, status, created_at) VALUES (?, ?, 0, 'done', ?)`
    ).run(caseId, s.id, now)
    db.prepare(
      `INSERT INTO tool_calls (case_id, session_id, tool, args_hash, risk, decision, created_at)
       VALUES (?, ?, 'Read', 'h', 'low', 'allow', ?)`
    ).run(caseId, s.id, now)
    insertMessageFts(db, 'hello', caseId, s.id, 1, 'user')
    insertMessageFts(db, 'other', caseId, keep.id, 1, 'user')
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
    const foreign = createSession(db, 'NAV-2', 'claude-agent-sdk')
    expect(() => deleteSession(db, argusHome, 'NAV-1', foreign.id)).toThrow(/unknown session/i)
    expect(() => deleteSession(db, argusHome, 'NAV-1', 1.5)).toThrow(/invalid session id/i)
    expect(listSessions(db, 'NAV-2')[0].id).toBe(foreign.id) // untouched
  })
})

describe('sessionStore — per-session provider instance and model', () => {
  it('pins instance + model at creation and surfaces them on the summary', () => {
    const s = createSession(db, 'NAV-1', {
      driverKind: 'github-copilot',
      instanceId: 'copilot-1',
      model: 'auto'
    })
    expect(s).toMatchObject({
      driverKind: 'github-copilot',
      instanceId: 'copilot-1',
      model: 'auto'
    })
    expect(listSessions(db, 'NAV-1')[0]).toMatchObject({ instanceId: 'copilot-1', model: 'auto' })
  })

  it('leaves instance and model null for the legacy string form', () => {
    // A row with nulls means "resolve from settings at send time" — the pre-multi-provider
    // behaviour, which must survive untouched for existing sessions.
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
    expect(s.instanceId).toBeNull()
    expect(s.model).toBeNull()
  })

  it('setSessionModel re-pins and reports whether anything changed', () => {
    const s = createSession(db, 'NAV-1', {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-default',
      model: 'claude-opus-4-8'
    })
    expect(
      setSessionModel(db, s.id, {
        driverKind: 'claude-agent-sdk',
        instanceId: 'claude-default',
        model: 'claude-opus-4-8'
      })
    ).toBe(false)
    expect(
      setSessionModel(db, s.id, {
        driverKind: 'claude-agent-sdk',
        instanceId: 'claude-default',
        model: 'claude-sonnet-5'
      })
    ).toBe(true)
    expect(sessionProvider(db, s.id)).toMatchObject({ model: 'claude-sonnet-5' })
  })

  it('drops the resume cursor when re-pinning across driver kinds, but not within one', () => {
    const s = createSession(db, 'NAV-1', {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-default',
      model: 'claude-opus-4-8'
    })
    db.prepare(`UPDATE sessions SET driver_cursor = 'cur-1' WHERE id = ?`).run(s.id)

    // same kind, different model — history is still resumable
    setSessionModel(db, s.id, {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-default',
      model: 'claude-sonnet-5'
    })
    expect(sessionCursor(db, s.id, 'claude-agent-sdk', 'claude-default')).toBe('cur-1')

    // switching driver kind invalidates it — a Copilot driver must never see it, and it
    // must not reappear if the user switches back
    setSessionModel(db, s.id, {
      driverKind: 'github-copilot',
      instanceId: 'copilot-1',
      model: 'auto'
    })
    expect(sessionCursor(db, s.id, 'github-copilot', 'copilot-1')).toBeNull()
  })

  it('sessionCursor refuses a cursor across two instances of the SAME driver kind', () => {
    // Two Claude accounts are two histories; the driver-kind guard alone would let one
    // resume the other's cursor.
    const s = createSession(db, 'NAV-1', {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-work',
      model: 'claude-opus-4-8'
    })
    db.prepare(`UPDATE sessions SET driver_cursor = 'cur-work' WHERE id = ?`).run(s.id)
    expect(sessionCursor(db, s.id, 'claude-agent-sdk', 'claude-work')).toBe('cur-work')
    expect(sessionCursor(db, s.id, 'claude-agent-sdk', 'claude-personal')).toBeNull()
  })

  it('still resumes a legacy row (null instance_id) on driver kind alone', () => {
    // Tightening the guard must not strand every pre-existing session's history.
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
    db.prepare(`UPDATE sessions SET driver_cursor = 'legacy' WHERE id = ?`).run(s.id)
    expect(sessionCursor(db, s.id, 'claude-agent-sdk', 'claude-default')).toBe('legacy')
  })

  it('setSessionModel is a no-op for an unknown session', () => {
    expect(
      setSessionModel(db, 9999, { driverKind: 'claude-agent-sdk', instanceId: 'x', model: 'y' })
    ).toBe(false)
  })
})
