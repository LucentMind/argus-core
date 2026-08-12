import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'

let dir: string
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function cols(db: ReturnType<typeof openDb>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
}

describe('autonomy schema', () => {
  it('creates autonomy_events and the outcome-stamp columns on a fresh db', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-db-'))
    const db = openDb(path.join(dir, 'argus.db'))
    expect(cols(db, 'autonomy_events')).toEqual([
      'id', 'lane', 'kind', 'from_tier', 'to_tier', 'note',
      'metrics_snapshot', 'created_at', 'acknowledged_at'
    ])
    expect(cols(db, 'findings')).toContain('posted_at')
    expect(cols(db, 'findings')).toContain('pushed_at')
    expect(cols(db, 'cases')).toContain('triaged_at')
    db.close()
  })

  it('migrates an existing db (openDb is rerun on every start)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-db-'))
    const file = path.join(dir, 'argus.db')
    openDb(file).close() // simulate a pre-existing db…
    const db = openDb(file) // …then the migration run
    expect(cols(db, 'cases')).toContain('triaged_at')
    db.close()
  })
})
