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
  sessionCursor
} from '../sessionStore'

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
})
