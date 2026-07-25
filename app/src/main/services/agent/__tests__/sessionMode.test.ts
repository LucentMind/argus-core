import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createSession, sessionMode } from '../sessionStore'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let db: DatabaseSync
let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mode-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
})

describe('session mode persistence', () => {
  it('defaults new sessions to investigation', () => {
    const s = createSession(db, 'c1', 'claude-agent-sdk')
    expect(s.mode).toBe('investigation')
    expect(sessionMode(db, s.id)).toBe('investigation')
  })

  it('creates a session pinned to review mode', () => {
    const s = createSession(db, 'c1', { driverKind: 'claude-agent-sdk', mode: 'review' })
    expect(sessionMode(db, s.id)).toBe('review')
  })

  it('sessionMode normalises an unrecognised stored value to the default (direct DB edit / version downgrade)', () => {
    const s = createSession(db, 'c1', 'claude-agent-sdk')
    db.prepare(`UPDATE sessions SET mode = ? WHERE id = ?`).run('some-future-mode', s.id)
    expect(sessionMode(db, s.id)).toBe('investigation')
  })
})
