import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { searchMessages } from '../chatSearch'

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
