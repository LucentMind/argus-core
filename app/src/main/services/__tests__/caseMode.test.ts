import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase, getCase, setCaseMode } from '../caseService'
import { listSessions, sessionMode } from '../agent/sessionStore'

let db: DatabaseSync
let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-casemode-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
})

describe('case-level mode', () => {
  it('defaults a new case to investigation', () => {
    expect(getCase(db, 'c1')?.activeMode).toBe('investigation')
  })

  it('creates a session bound to the mode when none exists', () => {
    const { sessionId } = setCaseMode(db, home, 'c1', 'review')
    expect(getCase(db, 'c1')?.activeMode).toBe('review')
    expect(sessionMode(db, sessionId)).toBe('review')
  })

  it("reuses that mode's most recent session instead of creating another", () => {
    const first = setCaseMode(db, home, 'c1', 'review').sessionId
    setCaseMode(db, home, 'c1', 'investigation')
    const again = setCaseMode(db, home, 'c1', 'review').sessionId
    expect(again).toBe(first)
  })

  it("leaves the other mode's chats intact when switching back", () => {
    const inv = listSessions(db, 'c1')[0]
    setCaseMode(db, home, 'c1', 'review')
    const back = setCaseMode(db, home, 'c1', 'investigation')
    expect(back.sessionId).toBe(inv.id)
    expect(sessionMode(db, inv.id)).toBe('investigation')
  })
})
