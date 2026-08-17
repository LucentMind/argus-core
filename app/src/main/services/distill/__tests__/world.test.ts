import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { buildWorld, WORLD_MSG_CLAMP, WORLD_SESSION_MAX_MSGS, type WorldClamps } from '../world'

let tmp: string
let db: DatabaseSync
let caseId: number

function insertSession(id: number, title: string): void {
  db.prepare(
    `INSERT INTO sessions (id, case_id, title, turn_count, created_at, updated_at)
     VALUES (?, ?, ?, 0, '2026-01-01', '2026-01-01')`
  ).run(id, caseId, title)
}

function indexMsg(sessionId: number, turnId: number, role: string, content: string): void {
  db.prepare(
    `INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES (?,?,?,?,?)`
  ).run(content, caseId, sessionId, turnId, role)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-world-'))
  db = openDb(path.join(tmp, 'argus.db'))
  createCase(db, path.join(tmp, 'home'), { slug: 'NAV-1', title: 't' })
  caseId = Number(
    (db.prepare(`SELECT id FROM cases WHERE slug='NAV-1'`).get() as { id: number }).id
  )
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('buildWorld', () => {
  it('returns an empty world for an unknown slug without touching the db', () => {
    const world = buildWorld(db, 'NO-SUCH-CASE')
    expect(world).toEqual({ sessions: [] })
  })

  it('(a) carries both sessions in id order, messages in rowid order with roles', () => {
    // insert session 2 first, then session 1 -- id order must win, not insertion order
    insertSession(2, 'second session')
    insertSession(1, 'first session')
    // messages inserted out of role/semantic order -- rowid order must be preserved
    indexMsg(1, 10, 'user', 'question one')
    indexMsg(1, 11, 'assistant', 'answer one')
    indexMsg(1, 12, 'tool', 'tool output one')
    indexMsg(2, 20, 'user', 'question two')

    const world = buildWorld(db, 'NAV-1')

    expect(world.sessions.map((s) => s.id)).toEqual([1, 2])
    expect(world.sessions[0].title).toBe('first session')
    expect(world.sessions[1].title).toBe('second session')
    expect(world.sessions[0].messages).toEqual([
      { role: 'user', content: 'question one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'tool', content: 'tool output one' }
    ])
    expect(world.sessions[1].messages).toEqual([{ role: 'user', content: 'question two' }])
    expect(world.droppedSessions).toBeUndefined()
    expect(world.sessions[0].droppedMessages).toBeUndefined()
  })

  it('(b) clamps an oversized message to head 6000 + marker + tail 2000, flagged truncated', () => {
    insertSession(1, 's1')
    const big = 'x'.repeat(20_000)
    indexMsg(1, 10, 'assistant', big)

    const world = buildWorld(db, 'NAV-1')
    const msg = world.sessions[0].messages[0]

    expect(msg.truncated).toBe(true)
    const expectedOmitted = big.length - WORLD_MSG_CLAMP // 20_000 - 8_000 = 12_000
    const marker = `[… ${expectedOmitted} chars omitted]`
    expect(msg.content).toBe('x'.repeat(6_000) + marker + 'x'.repeat(2_000))
    // byte-check: real U+2026 ellipsis, no U+FFFD replacement char anywhere
    expect(msg.content.includes('…')).toBe(true)
    expect(msg.content.includes('�')).toBe(false)
    expect(msg.content.includes('...')).toBe(false)
  })

  it('leaves a message untouched when it is exactly at the clamp', () => {
    insertSession(1, 's1')
    const exact = 'y'.repeat(WORLD_MSG_CLAMP)
    indexMsg(1, 10, 'user', exact)

    const world = buildWorld(db, 'NAV-1')
    expect(world.sessions[0].messages[0]).toEqual({ role: 'user', content: exact })
  })

  it('(c) keeps the last N messages and sets droppedMessages when over sessionMaxMsgs', () => {
    insertSession(1, 's1')
    for (let i = 1; i <= 5; i++) {
      indexMsg(1, i, i % 2 === 0 ? 'assistant' : 'user', `m${i}`)
    }
    const clamps: WorldClamps = {
      msgClamp: WORLD_MSG_CLAMP,
      sessionMaxMsgs: 3,
      sessionMaxBytes: 1_000_000,
      totalMaxBytes: 8_000_000
    }

    const world = buildWorld(db, 'NAV-1', clamps)

    expect(world.sessions[0].messages.map((m) => m.content)).toEqual(['m3', 'm4', 'm5'])
    expect(world.sessions[0].droppedMessages).toBe(2)
  })

  it('(d) drops oldest sessions first on total-cap overflow and sets droppedSessions', () => {
    insertSession(1, 'oldest')
    insertSession(2, 'middle')
    insertSession(3, 'newest')
    indexMsg(1, 10, 'user', 'a'.repeat(100))
    indexMsg(2, 20, 'user', 'b'.repeat(100))
    indexMsg(3, 30, 'user', 'c'.repeat(100))
    const clamps: WorldClamps = {
      msgClamp: WORLD_MSG_CLAMP,
      sessionMaxMsgs: WORLD_SESSION_MAX_MSGS,
      sessionMaxBytes: 1_000_000,
      totalMaxBytes: 150 // total is 300; only the newest session (100) fits under 150
    }

    const world = buildWorld(db, 'NAV-1', clamps)

    expect(world.sessions.map((s) => s.id)).toEqual([3])
    expect(world.droppedSessions).toBe(2)
  })

  it('terminates and keeps the last session even when it alone still exceeds the cap', () => {
    insertSession(1, 'oldest')
    insertSession(2, 'newest')
    indexMsg(1, 10, 'user', 'a'.repeat(100))
    indexMsg(2, 20, 'user', 'b'.repeat(100))
    const clamps: WorldClamps = {
      msgClamp: WORLD_MSG_CLAMP,
      sessionMaxMsgs: WORLD_SESSION_MAX_MSGS,
      sessionMaxBytes: 1_000_000,
      totalMaxBytes: 10 // even the single newest session (100 bytes) blows this
    }

    const world = buildWorld(db, 'NAV-1', clamps)

    // must not spin forever, and must not drop down to zero sessions
    expect(world.sessions.map((s) => s.id)).toEqual([2])
    expect(world.droppedSessions).toBe(1)
  })
})
