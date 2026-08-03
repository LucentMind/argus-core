import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase, getCase } from '../caseService'
import { applyReportRoles, listFindings } from '../findings'

function insertFinding(db: ReturnType<typeof openDb>, caseId: number, summary: string): number {
  const now = new Date().toISOString()
  const r = db
    .prepare(
      `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at) VALUES (?,?,?,?, 'pending', ?)`
    )
    .run(caseId, 1, 2, summary, now)
  return Number(r.lastInsertRowid)
}

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-findings-roles-'))
}

describe('applyReportRoles', () => {
  it('applies roles atomically, clears absent, enforces single root-cause', () => {
    const home = tmpHome()
    const db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'a', title: 'A' })
    createCase(db, home, { slug: 'b', title: 'B' })
    const caseA = getCase(db, 'a')!.id
    const caseB = getCase(db, 'b')!.id
    const id1 = insertFinding(db, caseA, 'Finding one')
    const id2 = insertFinding(db, caseA, 'Finding two')
    const id3 = insertFinding(db, caseA, 'Finding three')
    const id9 = insertFinding(db, caseB, 'Finding nine')

    const roleOf = (id: number): string | null =>
      (db.prepare(`SELECT role FROM findings WHERE id = ?`).get(id) as { role: string | null }).role

    applyReportRoles(db, caseA, [
      { findingId: id1, role: 'root-cause' },
      { findingId: id2, role: 'contributing' }
    ])
    expect(roleOf(id1)).toBe('root-cause')
    expect(roleOf(id2)).toBe('contributing')
    expect(roleOf(id3)).toBeNull() // absent from set → cleared

    expect(() =>
      applyReportRoles(db, caseA, [
        { findingId: id1, role: 'root-cause' },
        { findingId: id2, role: 'root-cause' }
      ])
    ).toThrow(/root-cause/)

    expect(() => applyReportRoles(db, caseA, [{ findingId: id9, role: 'symptom' }])).toThrow(
      /belong/
    )

    // failed calls changed nothing
    expect(roleOf(id1)).toBe('root-cause')
    expect(roleOf(id2)).toBe('contributing')
    expect(roleOf(id9)).toBeNull()

    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('rejects an invalid role value without touching the database', () => {
    const home = tmpHome()
    const db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'a', title: 'A' })
    const caseA = getCase(db, 'a')!.id
    const id1 = insertFinding(db, caseA, 'Finding one')

    expect(() =>
      applyReportRoles(db, caseA, [
        // @ts-expect-error invalid role
        { findingId: id1, role: 'bogus' }
      ])
    ).toThrow(/Invalid role/)

    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
})

describe('listFindings role-ranked ordering', () => {
  it('lists role-ranked then newest-first', () => {
    const home = tmpHome()
    const db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'c1', title: 'C1' })
    const caseId = getCase(db, 'c1')!.id
    const id1 = insertFinding(db, caseId, 'One')
    const id2 = insertFinding(db, caseId, 'Two')
    const id3 = insertFinding(db, caseId, 'Three')

    applyReportRoles(db, caseId, [
      { findingId: id3, role: 'symptom' },
      { findingId: id1, role: 'root-cause' }
    ])
    // id2 has no role assigned → cleared to null

    const list = listFindings(db, home, 'c1')
    expect(list.map((f) => f.id)).toEqual([id1, id3, id2])

    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
})
