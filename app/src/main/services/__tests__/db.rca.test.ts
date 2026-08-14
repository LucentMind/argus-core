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
