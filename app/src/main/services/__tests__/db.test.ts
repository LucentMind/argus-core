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

  it('adds a nullable turns.model column', () => {
    const db = openDb(tmpDbPath())
    const cols = db.prepare(`PRAGMA table_info(turns)`).all() as {
      name: string
      notnull: number
    }[]
    const model = cols.find((c) => c.name === 'model')
    expect(model).toBeDefined()
    expect(model!.notnull).toBe(0)
    db.close()
  })

  it('cases table has a nullable resolution column', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-db-'))
    const db = openDb(path.join(dir, 'a.db'))
    const cols = db.prepare(`PRAGMA table_info(cases)`).all() as { name: string; notnull: number }[]
    const res = cols.find((c) => c.name === 'resolution')
    expect(res).toBeDefined()
    expect(res!.notnull).toBe(0)
    db.close()
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
        .prepare(`SELECT id, driver_cursor, driver_kind, turn_count, title, mode FROM sessions`)
        .get() as never
      expect(row).toMatchObject({
        id: 1,
        driver_cursor: 'abc',
        driver_kind: 'claude-agent-sdk',
        turn_count: 5,
        title: '',
        mode: 'investigation'
      })
      const cols = migrated.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
      expect(cols.some((c) => c.name === 'mode')).toBe(true)
      migrated
        .prepare(`INSERT INTO sessions (case_id, created_at, updated_at) VALUES (1,'x','x')`)
        .run() // no UNIQUE violation
      migrated.close()
    })

    it('migrates sdk_session_id to driver_cursor + driver_kind, preserving values', () => {
      const file = path.join(tmp, 'pre-cursor.db')
      const old = new DatabaseSync(file)
      old.exec(`CREATE TABLE cases (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL, jira_key TEXT, status TEXT NOT NULL DEFAULT 'open',
        tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE, sdk_session_id TEXT, title TEXT NOT NULL DEFAULT '', turn_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`)
      old.exec(
        `INSERT INTO cases (slug, title, created_at, updated_at) VALUES ('NAV-1','t','x','x')`
      )
      old.exec(
        `INSERT INTO sessions (case_id, sdk_session_id, turn_count, created_at, updated_at) VALUES (1,'u-u-i-d',0,'x','x')`
      )
      old.close()
      const migrated = openDb(file)
      const row = migrated
        .prepare(`SELECT driver_cursor, driver_kind FROM sessions WHERE case_id = 1`)
        .get()
      expect(row).toEqual({ driver_cursor: 'u-u-i-d', driver_kind: 'claude-agent-sdk' })
      const cols = migrated.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
      expect(cols.some((c) => c.name === 'sdk_session_id')).toBe(false)
      migrated.close()
    })

    it('adds tool_calls.detail to fresh and existing DBs (idempotent)', () => {
      const db = openDb(':memory:')
      const cols = db.prepare(`PRAGMA table_info(tool_calls)`).all() as { name: string }[]
      expect(cols.some((c) => c.name === 'detail')).toBe(true)
      // nullable: an insert without detail must still work
      db.prepare(
        `INSERT INTO cases (slug, title, created_at, updated_at) VALUES ('c','t','x','x')`
      ).run()
      db.prepare(
        `INSERT INTO tool_calls (case_id, session_id, tool, args_hash, risk, decision, created_at)
         VALUES (1, 1, 'Bash', 'h', 'LOW', 'auto', 'x')`
      ).run()
      const row = db.prepare(`SELECT detail FROM tool_calls`).get() as { detail: string | null }
      expect(row.detail).toBeNull()
    })

    it('distill_jobs carries v2 columns; legacy rows read as kind=case', () => {
      const db = openDb(':memory:')
      const cols = (db.prepare(`PRAGMA table_info(distill_jobs)`).all() as { name: string }[]).map(
        (c) => c.name
      )
      for (const c of [
        'kind',
        'input_tokens',
        'output_tokens',
        'cost_usd',
        'duration_ms',
        'prompt_chars',
        'turn_count',
        'tool_call_count',
        'trajectory_json',
        'dropped_json'
      ]) {
        expect(cols).toContain(c)
      }
      db.prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at) VALUES ('c','done','{}','x')`
      ).run()
      expect((db.prepare(`SELECT kind FROM distill_jobs`).get() as { kind: string }).kind).toBe(
        'case'
      )
    })

    describe('increment 5 schema', () => {
      it('creates routine_run_items with a cascading FK to routine_runs', () => {
        const db = openDb(path.join(tmp, 'a.sqlite'))
        db.prepare(
          `INSERT INTO routine_runs (routine_id, case_slug, status, started_at)
           VALUES ('r', 'routine-r', 'running', '2026-01-01T00:00:00.000Z')`
        ).run()
        const runId = Number(
          (db.prepare(`SELECT MAX(id) AS id FROM routine_runs`).get() as { id: number }).id
        )
        db.prepare(
          `INSERT INTO routine_run_items (run_id, item_key, status, started_at)
           VALUES (?, 'ABC-1', 'processed', '2026-01-01T00:00:01.000Z')`
        ).run(runId)

        db.prepare(`DELETE FROM routine_runs WHERE id = ?`).run(runId)
        const left = db.prepare(`SELECT COUNT(*) AS n FROM routine_run_items`).get() as {
          n: number
        }
        expect(left.n).toBe(0)
        db.close()
      })

      it('creates routine_cursors keyed by routine', () => {
        const db = openDb(path.join(tmp, 'b.sqlite'))
        db.prepare(
          `INSERT INTO routine_cursors (routine_id, cursor, updated_at) VALUES ('r', 'x', 't')`
        ).run()
        expect(() =>
          db
            .prepare(
              `INSERT INTO routine_cursors (routine_id, cursor, updated_at) VALUES ('r','y','u')`
            )
            .run()
        ).toThrow()
        db.close()
      })

      it('adds cases.review_state to an existing database, defaulting every row to NULL', () => {
        const file = path.join(tmp, 'c.sqlite')
        const first = openDb(file)
        first
          .prepare(
            `INSERT INTO cases (slug, title, status, tags, created_at, updated_at)
             VALUES ('old', 'Old', 'open', '[]', 't', 't')`
          )
          .run()
        // Simulate a pre-increment-5 database by dropping the column back off.
        first.exec(`ALTER TABLE cases DROP COLUMN review_state`)
        first.close()

        const second = openDb(file)
        const cols = second.prepare(`PRAGMA table_info(cases)`).all() as { name: string }[]
        expect(cols.some((c) => c.name === 'review_state')).toBe(true)
        const row = second.prepare(`SELECT review_state FROM cases WHERE slug = 'old'`).get() as {
          review_state: string | null
        }
        // No backfill: NULL is already the right answer for every pre-existing case.
        expect(row.review_state).toBeNull()
        second.close()
      })

      it('is idempotent across reopens', () => {
        const file = path.join(tmp, 'd.sqlite')
        openDb(file).close()
        expect(() => openDb(file).close()).not.toThrow()
      })
    })

    describe('routine_runs.case_slug nullability (fix pass)', () => {
      it('drops NOT NULL on a fresh database', () => {
        const db = openDb(path.join(tmp, 'fresh.sqlite'))
        const cols = db.prepare(`PRAGMA table_info(routine_runs)`).all() as {
          name: string
          notnull: number
        }[]
        expect(cols.find((c) => c.name === 'case_slug')?.notnull).toBe(0)
        // A scoped run's row must actually accept NULL, not just report nullable.
        db.prepare(
          `INSERT INTO routine_runs (routine_id, case_slug, status, started_at)
           VALUES ('r', NULL, 'running', '2026-01-01T00:00:00.000Z')`
        ).run()
        db.close()
      })

      it('rebuilds a database whose routine_runs.case_slug predates the fix, preserving rows', () => {
        const file = path.join(tmp, 'legacy-runs.sqlite')
        const legacy = new DatabaseSync(file)
        legacy.exec(`CREATE TABLE routine_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          routine_id TEXT NOT NULL,
          case_slug TEXT NOT NULL,
          session_id INTEGER,
          status TEXT NOT NULL DEFAULT 'running',
          started_at TEXT NOT NULL,
          finished_at TEXT,
          summary TEXT,
          error TEXT
        )`)
        // Legacy-shaped databases also carry routine_run_items rows referencing routine_runs
        // via ON DELETE CASCADE — the exact shape that reproduced the cascade-delete bug (2 item
        // rows before the rebuild, 0 after) when the rebuild's DROP TABLE ran with foreign_keys
        // still ON. Without these rows here, an empty routine_run_items table makes the cascade
        // delete nothing and the test would pass with the bug present.
        legacy.exec(`CREATE TABLE routine_run_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES routine_runs(id) ON DELETE CASCADE,
          item_key TEXT NOT NULL,
          case_slug TEXT,
          status TEXT NOT NULL DEFAULT 'running',
          error TEXT,
          suggestion TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT
        )`)
        legacy
          .prepare(
            `INSERT INTO routine_runs
               (routine_id, case_slug, session_id, status, started_at, finished_at, summary, error)
             VALUES ('sweep', 'routine-sweep', 9, 'ok', '2026-01-01T00:00:00.000Z',
                     '2026-01-01T00:05:00.000Z', 'did the thing', NULL)`
          )
          .run()
        const legacyRunId = Number(
          (legacy.prepare(`SELECT MAX(id) AS id FROM routine_runs`).get() as { id: number }).id
        )
        legacy
          .prepare(
            `INSERT INTO routine_run_items (run_id, item_key, status, started_at)
             VALUES (?, 'ABC-1', 'processed', '2026-01-01T00:00:01.000Z')`
          )
          .run(legacyRunId)
        legacy
          .prepare(
            `INSERT INTO routine_run_items (run_id, item_key, status, started_at)
             VALUES (?, 'ABC-2', 'failed', '2026-01-01T00:00:02.000Z')`
          )
          .run(legacyRunId)
        legacy.close()

        const migrated = openDb(file)
        const cols = migrated.prepare(`PRAGMA table_info(routine_runs)`).all() as {
          name: string
          notnull: number
        }[]
        expect(cols.find((c) => c.name === 'case_slug')?.notnull).toBe(0)
        // The pre-existing row survived the rebuild untouched, including the columns added by
        // the trigger_kind/reviewed_at migrations that ran earlier in the same openDb() call.
        const row = migrated.prepare(`SELECT * FROM routine_runs`).get() as Record<string, unknown>
        expect(row).toMatchObject({
          id: legacyRunId,
          routine_id: 'sweep',
          case_slug: 'routine-sweep',
          session_id: 9,
          status: 'ok',
          summary: 'did the thing',
          trigger_kind: 'manual'
        })
        // The item rows — the whole point of this test — must survive the rebuild with their
        // run_id intact, not be cascade-deleted by the DROP TABLE routine_runs inside it.
        const items = migrated
          .prepare(`SELECT run_id, item_key, status FROM routine_run_items ORDER BY item_key`)
          .all() as { run_id: number; item_key: string; status: string }[]
        expect(items).toEqual([
          { run_id: legacyRunId, item_key: 'ABC-1', status: 'processed' },
          { run_id: legacyRunId, item_key: 'ABC-2', status: 'failed' }
        ])
        // The child FK must still resolve after the rebuild — no dangling references.
        expect(migrated.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
        // And a scoped run can now be inserted with no case at all.
        migrated
          .prepare(
            `INSERT INTO routine_runs (routine_id, case_slug, status, started_at)
             VALUES ('scoped', NULL, 'running', '2026-01-02T00:00:00.000Z')`
          )
          .run()
        migrated.close()

        // The column guard is what makes the rebuild one-time — a second open must not re-run it.
        const reopened = openDb(file)
        expect(
          (reopened.prepare(`SELECT COUNT(*) AS n FROM routine_runs`).get() as { n: number }).n
        ).toBe(2)
        expect(
          (
            reopened.prepare(`SELECT COUNT(*) AS n FROM routine_run_items`).get() as {
              n: number
            }
          ).n
        ).toBe(2)
        reopened.close()
      })
    })
  })
})
