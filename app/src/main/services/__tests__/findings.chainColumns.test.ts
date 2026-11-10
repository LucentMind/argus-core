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

function seed(extra: Record<string, string | number | null> = {}): number {
  const now = new Date().toISOString()
  const cols = [
    'case_id',
    'session_id',
    'summary',
    'review_state',
    'created_at',
    ...Object.keys(extra)
  ]
  const vals = [caseId, null, 'Race in parser', 'pending', now, ...Object.values(extra)]
  const res = db
    .prepare(`INSERT INTO findings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...vals)
  return Number(res.lastInsertRowid)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-chain-cols-'))
  db = openDb(path.join(home, 'argus.db'))
  caseId = createCase(db, home, { slug: 'CASE-A', title: 'A' }).id
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('chain columns', () => {
  it('adds status, role_source, caused_by and superseded_by once', () => {
    const names = (): string[] =>
      (db.prepare(`PRAGMA table_info(findings)`).all() as { name: string }[]).map((c) => c.name)
    expect(names()).toEqual(
      expect.arrayContaining(['status', 'role_source', 'caused_by', 'superseded_by'])
    )
    db.close()
    db = openDb(path.join(home, 'argus.db'))
    expect(names().filter((n) => n === 'caused_by')).toHaveLength(1)
  })

  it('reads a legacy row as confirmed with no source, cause or successor', () => {
    const id = seed()
    const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)!
    expect(row.status).toBe('confirmed')
    expect(row.roleSource).toBeNull()
    expect(row.causedBy).toBeNull()
    expect(row.supersededBy).toBeNull()
  })

  it('reads stored values back, and an unknown status or source as the legacy defaults', () => {
    const parent = seed()
    const id = seed({
      status: 'hypothesis',
      role: 'symptom',
      role_source: 'agent',
      caused_by: parent,
      superseded_by: parent
    })
    const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)!
    expect(row.status).toBe('hypothesis')
    expect(row.roleSource).toBe('agent')
    expect(row.causedBy).toBe(parent)
    expect(row.supersededBy).toBe(parent)
    const odd = seed({ status: 'maybe', role_source: 'robot' })
    const oddRow = listFindings(db, home, 'CASE-A').find((f) => f.id === odd)!
    expect(oddRow.status).toBe('confirmed')
    expect(oddRow.roleSource).toBeNull()
  })
})
