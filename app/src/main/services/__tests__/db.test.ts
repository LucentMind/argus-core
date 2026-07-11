import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-test-'))
  return path.join(dir, 'argus.db')
}

describe('openDb', () => {
  it('creates schema idempotently (open twice, no throw)', () => {
    const p = tmpDbPath()
    const db1 = openDb(p)
    db1.close()
    const db2 = openDb(p)
    const tables = db2
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`)
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain('cases')
    expect(names).toContain('evidence')
    expect(names).toContain('evidence_fts')
    db2.close()
  })

  it('enforces unique case slug', () => {
    const db = openDb(tmpDbPath())
    const ins = db.prepare(
      `INSERT INTO cases (slug, title, status, tags, created_at, updated_at)
       VALUES (?, ?, 'open', '[]', ?, ?)`
    )
    const now = new Date().toISOString()
    ins.run('NAVAPI-1', 'a', now, now)
    expect(() => ins.run('NAVAPI-1', 'b', now, now)).toThrow()
    db.close()
  })

  describe('Wave 1 schema', () => {
    let db: DatabaseSync
    let tmp: string

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-test-'))
      const dbFile = path.join(tmp, 'test.db')
      db = openDb(dbFile)
    })

    afterEach(() => {
      db.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    it('creates wave-1 agent tables', () => {
      const names = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') OR type='table'`
        )
        .all() as unknown as { name: string }[]
      const nameList = names.map((r) => r.name)
      for (const t of ['sessions', 'turns', 'tool_calls', 'messages_fts']) {
        expect(nameList).toContain(t)
      }
    })

    it('adds cases.workspaces to a pre-existing wave-0 database', () => {
      const file = path.join(tmp, 'old.db')
      const old = new DatabaseSync(file)
      old.exec(`CREATE TABLE cases (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL, jira_key TEXT, status TEXT NOT NULL DEFAULT 'open',
        tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`)
      old.close()
      const upgraded = openDb(file)
      const cols = upgraded.prepare(`PRAGMA table_info(cases)`).all() as unknown as {
        name: string
      }[]
      const colNames = cols.map((r) => r.name)
      expect(colNames).toContain('workspaces')
      upgraded.close()
    })

    it('allows multiple sessions per case and defaults title to empty', () => {
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO cases (slug, title, created_at, updated_at) VALUES ('NAV-1','t',?,?)`
      ).run(now, now)
      const caseId = Number(db.prepare(`SELECT id FROM cases WHERE slug='NAV-1'`).get()!.id)
      db.prepare(`INSERT INTO sessions (case_id, created_at, updated_at) VALUES (?,?,?)`).run(
        caseId,
        now,
        now
      )
      db.prepare(`INSERT INTO sessions (case_id, created_at, updated_at) VALUES (?,?,?)`).run(
        caseId,
        now,
        now
      )
      const rows = db.prepare(`SELECT title FROM sessions WHERE case_id = ?`).all(caseId) as {
        title: string
      }[]
      expect(rows).toHaveLength(2)
      expect(rows[0].title).toBe('')
    })

    it('migrates a legacy UNIQUE(case_id) sessions table in place', () => {
      const file = path.join(tmp, 'legacy.db')
      const legacy = new DatabaseSync(file)
      legacy.exec(`CREATE TABLE cases (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, jira_key TEXT, status TEXT NOT NULL DEFAULT 'open', tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL UNIQUE REFERENCES cases(id) ON DELETE CASCADE, sdk_session_id TEXT, turn_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`)
      legacy.exec(
        `INSERT INTO cases (slug, title, created_at, updated_at) VALUES ('OLD-1','t','x','x')`
      )
      legacy.exec(
        `INSERT INTO sessions (case_id, sdk_session_id, turn_count, created_at, updated_at) VALUES (1,'abc',5,'x','x')`
      )
      legacy.close()
      const migrated = openDb(file)
      const row = migrated
        .prepare(`SELECT id, sdk_session_id, turn_count, title FROM sessions`)
        .get() as never
      expect(row).toMatchObject({ id: 1, sdk_session_id: 'abc', turn_count: 5, title: '' })
      migrated
        .prepare(`INSERT INTO sessions (case_id, created_at, updated_at) VALUES (1,'x','x')`)
        .run() // no UNIQUE violation
      migrated.close()
    })
  })
})
