import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createSession } from '../sessionStore'
import {
  sessionRunOptions,
  setSessionRunOptions,
  sessionPermissionMode,
  setSessionPermissionMode
} from '../sessionStore'

let db: DatabaseSync
let sessionId: number

beforeEach(() => {
  db = openDb(':memory:')
  db.prepare(`INSERT INTO cases (slug, title, created_at, updated_at) VALUES (?,?,?,?)`).run(
    'c1',
    'Case One',
    '2026-08-01',
    '2026-08-01'
  )
  sessionId = createSession(db, 'c1', { driverKind: 'claude-agent-sdk' }).id
})

describe('session run options', () => {
  it('is empty for a fresh session', () => {
    expect(sessionRunOptions(db, sessionId)).toEqual([])
  })

  it('round-trips a selection', () => {
    expect(setSessionRunOptions(db, sessionId, [{ id: 'effort', value: 'xhigh' }])).toBe(true)
    expect(sessionRunOptions(db, sessionId)).toEqual([{ id: 'effort', value: 'xhigh' }])
  })

  it('reports no change when the value is identical', () => {
    setSessionRunOptions(db, sessionId, [{ id: 'effort', value: 'xhigh' }])
    expect(setSessionRunOptions(db, sessionId, [{ id: 'effort', value: 'xhigh' }])).toBe(false)
  })

  it('clears back to NULL rather than storing an empty array', () => {
    setSessionRunOptions(db, sessionId, [{ id: 'effort', value: 'xhigh' }])
    expect(setSessionRunOptions(db, sessionId, [])).toBe(true)
    const raw = db
      .prepare(`SELECT run_options FROM sessions WHERE id = ?`)
      .get(sessionId) as { run_options: string | null }
    expect(raw.run_options).toBeNull()
  })

  it('survives a corrupt stored value without throwing', () => {
    db.prepare(`UPDATE sessions SET run_options = ? WHERE id = ?`).run('not json', sessionId)
    expect(sessionRunOptions(db, sessionId)).toEqual([])
  })

  it('returns false for a session id that does not exist', () => {
    expect(setSessionRunOptions(db, 999999, [{ id: 'effort', value: 'xhigh' }])).toBe(false)
  })

  it('reports no change when the same selections are supplied in a different order', () => {
    setSessionRunOptions(db, sessionId, [
      { id: 'effort', value: 'max' },
      { id: 'thinking', value: true }
    ])
    expect(
      setSessionRunOptions(db, sessionId, [
        { id: 'thinking', value: true },
        { id: 'effort', value: 'max' }
      ])
    ).toBe(false)
  })
})

describe('session permission mode', () => {
  it('is null for a fresh session, meaning "use the settings default"', () => {
    expect(sessionPermissionMode(db, sessionId)).toBeNull()
  })

  it('round-trips', () => {
    expect(setSessionPermissionMode(db, sessionId, 'acceptEdits')).toBe(true)
    expect(sessionPermissionMode(db, sessionId)).toBe('acceptEdits')
  })

  it('rejects a value that is not a real permission mode', () => {
    db.prepare(`UPDATE sessions SET permission_mode = ? WHERE id = ?`).run('bogus', sessionId)
    expect(sessionPermissionMode(db, sessionId)).toBeNull()
  })

  it('returns false for a session id that does not exist', () => {
    expect(setSessionPermissionMode(db, 999999, 'acceptEdits')).toBe(false)
  })
})
