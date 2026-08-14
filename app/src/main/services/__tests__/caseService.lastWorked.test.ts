import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, listCases, getCase, setCaseStatus } from '../caseService'

let home: string
let db: DatabaseSync

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
})

const T = (n: number): string => `2026-08-01T10:0${n}:00.000Z`

function mkCase(slug: string): number {
  return createCase(db, home, { slug, title: slug }).id
}

function addSession(caseId: number, mode: 'investigation' | 'review'): number {
  const r = db
    .prepare(
      `INSERT INTO sessions (case_id, mode, created_at, updated_at)
       VALUES (?, ?, '2026-08-01T09:00:00.000Z', '2026-08-01T09:00:00.000Z')`
    )
    .run(caseId, mode)
  return Number(r.lastInsertRowid)
}

function addTurn(caseId: number, sessionId: number, at: string): void {
  db.prepare(
    `INSERT INTO turns (case_id, session_id, turn_index, created_at) VALUES (?, ?, 0, ?)`
  ).run(caseId, sessionId, at)
}

function addEvidence(caseId: number, at: string): void {
  db.prepare(
    `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
     VALUES (?, ?, 'sha', 'text', 1, 'upload', '{}', ?)`
  ).run(caseId, `evidence/e-${at}.txt`, at)
}

function lastWorked(slug: string): string | null {
  return listCases(db).find((c) => c.slug === slug)!.lastWorkedAt
}

describe('listCases lastWorkedAt', () => {
  it('is null for a case no turn has ever run in', () => {
    mkCase('LW-1')
    expect(lastWorked('LW-1')).toBeNull()
  })

  it('is the newest turn timestamp', () => {
    const id = mkCase('LW-2')
    const s = addSession(id, 'investigation')
    addTurn(id, s, T(1))
    addTurn(id, s, T(5))
    addTurn(id, s, T(3))
    expect(lastWorked('LW-2')).toBe(T(5))
  })

  it('spans modes — a review turn counts as work just as an investigation turn does', () => {
    const id = mkCase('LW-3')
    addTurn(id, addSession(id, 'investigation'), T(2))
    addTurn(id, addSession(id, 'review'), T(7))
    expect(lastWorked('LW-3')).toBe(T(7))

    const other = mkCase('LW-4')
    addTurn(other, addSession(other, 'review'), T(2))
    addTurn(other, addSession(other, 'investigation'), T(7))
    expect(lastWorked('LW-4')).toBe(T(7))
  })

  it('does NOT move for a metadata write that bumps updatedAt', () => {
    const id = mkCase('LW-5')
    addTurn(id, addSession(id, 'investigation'), T(1))
    const before = listCases(db).find((c) => c.slug === 'LW-5')!

    setCaseStatus(db, home, 'LW-5', 'closed', 'solved')

    const after = listCases(db).find((c) => c.slug === 'LW-5')!
    // The whole point of the field: `updatedAt` moved, `lastWorkedAt` did not.
    expect(after.updatedAt).not.toBe(before.updatedAt)
    expect(after.lastWorkedAt).toBe(T(1))
  })

  it('does NOT move for evidence — ingest is not the user running a turn', () => {
    const id = mkCase('LW-6')
    addTurn(id, addSession(id, 'investigation'), T(1))
    addEvidence(id, T(9))
    expect(lastWorked('LW-6')).toBe(T(1))
  })

  it('is null from getCase, which does not derive it', () => {
    const id = mkCase('LW-7')
    addTurn(id, addSession(id, 'investigation'), T(4))
    expect(getCase(db, 'LW-7')!.lastWorkedAt).toBeNull()
  })

  it('is never written to case.json — it is derived, not stored', () => {
    const id = mkCase('LW-8')
    addTurn(id, addSession(id, 'investigation'), T(4))
    setCaseStatus(db, home, 'LW-8', 'closed', 'solved')
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'cases', 'LW-8', 'case.json'), 'utf8')
    ) as Record<string, unknown>
    expect('lastWorkedAt' in onDisk).toBe(false)
    // Guards the same strip for the fields that were already derived, so a future edit to
    // stripDerived cannot quietly start persisting any of them.
    expect('phase' in onDisk).toBe(false)
    expect('actionItems' in onDisk).toBe(false)
    expect('id' in onDisk).toBe(false)
  })
})
