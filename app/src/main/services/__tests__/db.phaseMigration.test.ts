import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'

let home: string
let file: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  file = path.join(home, 'argus.db')
})

/** Seed a database the way a pre-migration build left it, then reopen to migrate. */
function seedLegacy(rows: Array<{ slug: string; status: string }>): DatabaseSync {
  const db = openDb(file)
  for (const r of rows) {
    db.prepare(
      `INSERT INTO cases (slug, title, status, tags, created_at, updated_at)
       VALUES (?, ?, ?, '[]', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')`
    ).run(r.slug, r.slug, r.status)
  }
  db.close()
  return openDb(file)
}

describe('phase migration', () => {
  it('adds the pin columns', () => {
    const db = openDb(file)
    const cols = (db.prepare(`PRAGMA table_info(cases)`).all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols).toContain('phase_pin')
    expect(cols).toContain('phase_pinned_at')
  })

  it('converts a stored rca-drafted row into open + a pin stamped at updated_at', () => {
    const db = seedLegacy([{ slug: 'RCA-1', status: 'rca-drafted' }])
    const row = db
      .prepare(`SELECT status, phase_pin, phase_pinned_at FROM cases WHERE slug = 'RCA-1'`)
      .get() as { status: string; phase_pin: string | null; phase_pinned_at: string | null }
    expect(row.status).toBe('open')
    expect(row.phase_pin).toBe('rca-drafted')
    expect(row.phase_pinned_at).toBe('2026-07-02T00:00:00.000Z')
  })

  it('converts a stored analyzing row to open with no pin — it re-derives', () => {
    const db = seedLegacy([{ slug: 'AN-1', status: 'analyzing' }])
    const row = db
      .prepare(`SELECT status, phase_pin FROM cases WHERE slug = 'AN-1'`)
      .get() as { status: string; phase_pin: string | null }
    expect(row.status).toBe('open')
    expect(row.phase_pin).toBeNull()
  })

  it('leaves open and closed rows alone', () => {
    const db = seedLegacy([
      { slug: 'OP-1', status: 'open' },
      { slug: 'CL-1', status: 'closed' }
    ])
    const rows = db
      .prepare(`SELECT slug, status, phase_pin FROM cases ORDER BY slug`)
      .all() as { slug: string; status: string; phase_pin: string | null }[]
    expect(rows).toEqual([
      { slug: 'CL-1', status: 'closed', phase_pin: null },
      { slug: 'OP-1', status: 'open', phase_pin: null }
    ])
  })

  it('is idempotent across repeated opens', () => {
    const db = seedLegacy([{ slug: 'RCA-2', status: 'rca-drafted' }])
    db.close()
    const again = openDb(file)
    const row = again
      .prepare(`SELECT status, phase_pin, phase_pinned_at FROM cases WHERE slug = 'RCA-2'`)
      .get() as { status: string; phase_pin: string; phase_pinned_at: string }
    expect(row).toEqual({
      status: 'open',
      phase_pin: 'rca-drafted',
      phase_pinned_at: '2026-07-02T00:00:00.000Z'
    })
  })
})
