import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
})
