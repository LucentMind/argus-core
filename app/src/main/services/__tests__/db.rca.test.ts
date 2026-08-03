import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
})
