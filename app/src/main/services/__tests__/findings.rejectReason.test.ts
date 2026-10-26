import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { listFindings } from '../findings'

let home: string
let db: DatabaseSync
let caseId: number

function seed(state: 'pending' | 'accepted' | 'rejected', extra: Record<string, unknown> = {}): number {
  const now = new Date().toISOString()
  const cols = ['case_id', 'session_id', 'summary', 'review_state', 'created_at', ...Object.keys(extra)]
  const vals = [caseId, null, 'Race in parser', state, now, ...Object.values(extra)]
  const res = db
    .prepare(`INSERT INTO findings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...(vals as (string | number | null)[]))
  return Number(res.lastInsertRowid)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-reject-'))
  db = openDb(path.join(home, 'argus.db'))
  caseId = createCase(db, home, { slug: 'CASE-A', title: 'A' }).id
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('reject reason columns', () => {
  it('adds reject_tag and reject_note as nullable columns, once', () => {
    const cols = (db.prepare(`PRAGMA table_info(findings)`).all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols).toEqual(expect.arrayContaining(['reject_tag', 'reject_note']))
    // A second open of the same file must not throw on an already-added column.
    db.close()
    db = openDb(path.join(home, 'argus.db'))
    expect(
      (db.prepare(`PRAGMA table_info(findings)`).all() as { name: string }[]).filter(
        (c) => c.name === 'reject_tag'
      )
    ).toHaveLength(1)
  })

  it('reads a pre-existing row back with both fields null', () => {
    const id = seed('rejected', { review_actor: 'human' })
    const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)
    expect(row?.rejectTag).toBeNull()
    expect(row?.rejectNote).toBeNull()
  })

  it('reads a stored tag and note back, and an unknown stored tag as null', () => {
    const ok = seed('rejected', { review_actor: 'human', reject_tag: 'wrong', reject_note: 'log is from the old build' })
    const bad = seed('rejected', { review_actor: 'human', reject_tag: 'vibes', reject_note: 'n' })
    const rows = listFindings(db, home, 'CASE-A')
    expect(rows.find((f) => f.id === ok)).toMatchObject({ rejectTag: 'wrong', rejectNote: 'log is from the old build' })
    expect(rows.find((f) => f.id === bad)).toMatchObject({ rejectTag: null, rejectNote: 'n' })
  })
})
