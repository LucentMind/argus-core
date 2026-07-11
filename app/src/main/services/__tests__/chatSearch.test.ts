import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { searchMessages, searchAllMessages } from '../chatSearch'

let tmp: string, db: DatabaseSync, caseId: number

function indexMsg(sessionId: number, turnId: number, role: string, content: string): void {
  db.prepare(
    `INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES (?,?,?,?,?)`
  ).run(content, caseId, sessionId, turnId, role)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-cs-'))
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

describe('searchMessages', () => {
  it('finds hits scoped to the case with snippets, newest-relevant first', () => {
    indexMsg(1, 10, 'user', 'the braking system failed near the tunnel')
    indexMsg(2, 20, 'assistant', 'braking pressure log shows a dropout')
    indexMsg(1, 11, 'user', 'unrelated navigation chatter')
    const r = searchMessages(db, 'NAV-1', 'braking')
    expect(r.error).toBeUndefined()
    expect(r.hits).toHaveLength(2)
    expect(r.hits.every((h) => h.snippet.includes('«braking»'))).toBe(true)
    expect(new Set(r.hits.map((h) => h.sessionId))).toEqual(new Set([1, 2]))
  })

  it('returns empty for blank queries and an error for FTS syntax errors', () => {
    expect(searchMessages(db, 'NAV-1', '  ')).toEqual({ hits: [] })
    const r = searchMessages(db, 'NAV-1', '"unbalanced')
    expect(r.hits).toEqual([])
    expect(r.error).toBeTruthy()
  })
})

describe('searchAllMessages', () => {
  it('spans cases, joins session titles, and tags hits as chat', () => {
    createCase(db, path.join(tmp, 'home'), { slug: 'NAV-2', title: 't2' })
    const case2 = Number(
      (db.prepare(`SELECT id FROM cases WHERE slug='NAV-2'`).get() as { id: number }).id
    )
    db.prepare(
      `INSERT INTO sessions (id, case_id, title, turn_count, created_at, updated_at)
       VALUES (1, ?, 'braking session', 0, '2026-01-01', '2026-01-01')`
    ).run(caseId)
    indexMsg(1, 10, 'user', 'the braking system failed')
    db.prepare(
      `INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES (?,?,?,?,?)`
    ).run('braking pressure dropout', case2, 7, 20, 'assistant')

    const hits = searchAllMessages(db, 'braking')
    expect(hits).toHaveLength(2)
    expect(new Set(hits.map((h) => h.caseSlug))).toEqual(new Set(['NAV-1', 'NAV-2']))
    expect(hits.every((h) => h.kind === 'chat')).toBe(true)
    expect(hits.every((h) => h.snippet.includes('«braking»'))).toBe(true)
    const titled = hits.find((h) => h.sessionId === 1)!
    expect(titled.sessionTitle).toBe('braking session')
    const untitled = hits.find((h) => h.sessionId === 7)!
    expect(untitled.sessionTitle).toBe('')
  })

  it('optionally scopes to one case', () => {
    indexMsg(1, 10, 'user', 'the braking system failed')
    expect(searchAllMessages(db, 'braking', 'NAV-1')).toHaveLength(1)
    expect(searchAllMessages(db, 'braking', 'NAV-9')).toHaveLength(0)
  })

  it('escapes FTS syntax instead of erroring, and returns [] for blank queries', () => {
    indexMsg(1, 10, 'user', 'quote "unbalanced here')
    expect(searchAllMessages(db, '"unbalanced')).toHaveLength(1)
    expect(searchAllMessages(db, '   ')).toEqual([])
  })

  it('returns [] instead of throwing when the FTS query itself errors', () => {
    db.exec('DROP TABLE messages_fts')
    expect(() => searchAllMessages(db, 'braking')).not.toThrow()
    expect(searchAllMessages(db, 'braking')).toEqual([])
  })
})
