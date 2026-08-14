import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
})

/** The legacy fixtures below predate a column, not the case itself — without a live `cases`
 *  row their job would be an orphan, which openDb now purges. `CREATE TABLE IF NOT EXISTS`
 *  in SCHEMA leaves this table alone; the remaining columns arrive via the ALTER migrations. */
function seedLegacyCase(db: DatabaseSync, slug: string): void {
  db.exec(`CREATE TABLE cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    jira_key TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  db.prepare(
    `INSERT INTO cases (slug, title, created_at, updated_at) VALUES (?, 't', 'x', 'x')`
  ).run(slug)
}

describe('rca schema', () => {
  it('adds findings.role and creates rca_jobs, idempotently', () => {
    const dbPath = path.join(home, 'argus.db')
    const db = openDb(dbPath)
    const cols = db.prepare(`PRAGMA table_info(findings)`).all() as { name: string }[]
    expect(cols.map((c) => c.name)).toContain('role')
    const t = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rca_jobs'`)
      .get()
    expect(t).toBeTruthy()
    // re-open the same file: migration must not throw or duplicate
    db.close()
    expect(() => openDb(dbPath)).not.toThrow()
  })

  it('adds template_snapshot to an rca_jobs table that predates it', () => {
    const file = path.join(home, 'legacy.db')
    const legacy = new DatabaseSync(file)
    seedLegacyCase(legacy, 'a')
    legacy.exec(`CREATE TABLE rca_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_slug TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      input_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
    legacy.exec(
      `INSERT INTO rca_jobs (case_slug, input_snapshot, created_at) VALUES ('a','{}','x')`
    )
    legacy.close()

    const db = openDb(file)
    const cols = (db.prepare(`PRAGMA table_info(rca_jobs)`).all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols).toContain('template_snapshot')
    const row = db.prepare(`SELECT template_snapshot FROM rca_jobs WHERE case_slug='a'`).get() as {
      template_snapshot: string | null
    }
    expect(row.template_snapshot).toBeNull()
    db.close()
  })

  it('adds dropped_sections to an rca_jobs table that predates it', () => {
    const file = path.join(home, 'legacy-dropped.db')
    const legacy = new DatabaseSync(file)
    seedLegacyCase(legacy, 'a')
    legacy.exec(`CREATE TABLE rca_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_slug TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      input_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
    legacy.exec(
      `INSERT INTO rca_jobs (case_slug, input_snapshot, created_at) VALUES ('a','{}','x')`
    )
    legacy.close()

    const db = openDb(file)
    const cols = (db.prepare(`PRAGMA table_info(rca_jobs)`).all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols).toContain('dropped_sections')
    const row = db.prepare(`SELECT dropped_sections FROM rca_jobs WHERE case_slug='a'`).get() as {
      dropped_sections: string | null
    }
    expect(row.dropped_sections).toBeNull()
    db.close()
  })

  it('purges rca_jobs left behind by cases deleted before deleteCase cleaned them up', () => {
    // deleteCase only started removing rca_jobs after this fix, so existing databases still
    // carry rows — including report bodies — for slugs whose case is long gone. Nothing can
    // read them (every read is keyed by a live slug), so they are purged on open.
    const file = path.join(home, 'orphans.db')
    const db = openDb(file)
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO cases (slug, title, created_at, updated_at) VALUES ('LIVE-1','t',?,?)`
    ).run(now, now)
    for (const slug of ['LIVE-1', 'DEAD-1']) {
      db.prepare(
        `INSERT INTO rca_jobs (case_slug, state, input_snapshot, raw_output, created_at)
         VALUES (?, 'done', '{}', 'report body', ?)`
      ).run(slug, now)
    }
    db.close()

    const reopened = openDb(file)

    const slugs = (
      reopened.prepare(`SELECT case_slug FROM rca_jobs`).all() as { case_slug: string }[]
    ).map((r) => r.case_slug)
    expect(slugs).toEqual(['LIVE-1'])
    reopened.close()
  })

  it('creates dropped_sections on a fresh database and re-opening is idempotent', () => {
    const file = path.join(home, 'fresh-dropped.db')
    const db = openDb(file)
    const cols = (db.prepare(`PRAGMA table_info(rca_jobs)`).all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols).toContain('dropped_sections')
    db.close()
    expect(() => openDb(file).close()).not.toThrow()
  })
})
