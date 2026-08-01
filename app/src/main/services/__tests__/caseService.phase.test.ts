import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, listCases, getCase } from '../caseService'

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
    `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, created_at)
     VALUES (?, ?, 'sha', 'text', 1, ?)`
  ).run(caseId, `e-${at}.txt`, at)
}

function linkPr(caseId: number, at: string): void {
  db.prepare(
    `INSERT INTO pr_bindings (case_id, owner, repo, number, url, source, detected_at)
     VALUES (?, 'o', 'r', 1, 'https://example.test/pr/1', 'manual', ?)`
  ).run(caseId, at)
}

describe('listCases phase derivation', () => {
  it('is open for a brand-new case', () => {
    mkCase('NEW-1')
    expect(listCases(db)[0].phase).toBe('open')
  })

  it('is analyzing once evidence lands, with no turn needed', () => {
    const id = mkCase('AN-1')
    addEvidence(id, T(1))
    expect(listCases(db)[0].phase).toBe('analyzing')
  })

  it('is pr-created after a PR is linked', () => {
    const id = mkCase('PR-1')
    addTurn(id, addSession(id, 'investigation'), T(1))
    linkPr(id, T(2))
    expect(listCases(db)[0].phase).toBe('pr-created')
  })

  it('is reviewing after a review-mode turn', () => {
    const id = mkCase('RV-1')
    linkPr(id, T(1))
    addTurn(id, addSession(id, 'review'), T(2))
    expect(listCases(db)[0].phase).toBe('reviewing')
  })

  it('returns to analyzing when investigation resumes after a review', () => {
    const id = mkCase('BACK-1')
    linkPr(id, T(1))
    addTurn(id, addSession(id, 'review'), T(2))
    addTurn(id, addSession(id, 'investigation'), T(3))
    expect(listCases(db)[0].phase).toBe('analyzing')
  })

  it('reads a pin, and lets a newer turn beat it', () => {
    const id = mkCase('PIN-1')
    db.prepare(`UPDATE cases SET phase_pin = 'rca-drafted', phase_pinned_at = ? WHERE id = ?`).run(
      T(5),
      id
    )
    expect(listCases(db)[0].phase).toBe('rca-drafted')
    addTurn(id, addSession(id, 'investigation'), T(6))
    expect(listCases(db)[0].phase).toBe('analyzing')
  })

  it('normalises an unrecognised stored phase_pin to null (direct DB edit / version downgrade)', () => {
    // Same defence-in-depth convention as rowToCase's activeMode guard: a stored value that
    // isn't a real CASE_PHASE_PINS member must not survive into phasePin, or it would surface
    // as a bogus phase forever — a pin is never cleared, only outranked.
    const id = mkCase('GARBAGE-PIN-1')
    db.prepare(
      `UPDATE cases SET phase_pin = 'some-future-pin', phase_pinned_at = ? WHERE id = ?`
    ).run(T(5), id)
    expect(getCase(db, 'GARBAGE-PIN-1')!.phase).toBe('open')
    expect(listCases(db)[0].phase).toBe('open')
  })

  it('derives per case, not globally', () => {
    const a = mkCase('A-1')
    const b = mkCase('B-1')
    addEvidence(a, T(1))
    linkPr(b, T(2))
    const bySlug = Object.fromEntries(listCases(db).map((c) => [c.slug, c.phase]))
    expect(bySlug).toEqual({ 'A-1': 'analyzing', 'B-1': 'pr-created' })
  })

  it('getCase agrees with listCases', () => {
    const id = mkCase('AGREE-1')
    linkPr(id, T(1))
    addTurn(id, addSession(id, 'review'), T(2))
    expect(getCase(db, 'AGREE-1')!.phase).toBe('reviewing')
    expect(listCases(db)[0].phase).toBe('reviewing')
  })

  // sessions.mode is NOT NULL DEFAULT 'investigation' (db.ts's migration backfills every
  // legacy row), so a session can never actually hold a NULL mode — the reachable gap is a
  // turn whose session_id matches no session row at all (turns.session_id carries no FK
  // constraint), which is exactly what the LEFT JOIN + COALESCE in readCaseSignals guards.
  it('treats a turn with no matching session as investigation', () => {
    const id = mkCase('LEGACY-1')
    db.prepare(
      `INSERT INTO turns (case_id, session_id, turn_index, created_at) VALUES (?, 999999, 0, ?)`
    ).run(id, T(1))
    expect(listCases(db)[0].phase).toBe('analyzing')
  })
})

import { pinCasePhase, setCaseStatus } from '../caseService'

describe('pinCasePhase', () => {
  it('stores the pin and shows it as the phase', () => {
    mkCase('PIN-2')
    const rec = pinCasePhase(db, home, 'PIN-2', 'rca-drafted')
    expect(rec.phase).toBe('rca-drafted')
    expect(getCase(db, 'PIN-2')!.phase).toBe('rca-drafted')
  })

  it('mirrors the pin into case.json', () => {
    mkCase('PIN-3')
    pinCasePhase(db, home, 'PIN-3', 'rca-drafted')
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'cases', 'PIN-3', 'case.json'), 'utf8')
    ) as { phasePin: string; phasePinnedAt: string }
    expect(onDisk.phasePin).toBe('rca-drafted')
    expect(typeof onDisk.phasePinnedAt).toBe('string')
  })

  it('rejects an unknown pin', () => {
    mkCase('PIN-4')
    expect(() => pinCasePhase(db, home, 'PIN-4', 'analyzing' as never)).toThrow(/Unknown phase pin/)
  })

  it('loses to a later turn — a pin is not sticky', () => {
    const id = mkCase('PIN-5')
    pinCasePhase(db, home, 'PIN-5', 'rca-drafted')
    addTurn(id, addSession(id, 'investigation'), '2099-01-01T00:00:00.000Z')
    expect(getCase(db, 'PIN-5')!.phase).toBe('analyzing')
  })
})

describe('setCaseStatus lifecycle', () => {
  it('closing overrides an otherwise busy case', () => {
    const id = mkCase('CL-2')
    addTurn(id, addSession(id, 'review'), T(9))
    setCaseStatus(db, home, 'CL-2', 'closed', 'solved')
    expect(getCase(db, 'CL-2')!.phase).toBe('closed')
  })

  it('reopening restores the derived phase', () => {
    const id = mkCase('CL-3')
    addTurn(id, addSession(id, 'review'), T(9))
    setCaseStatus(db, home, 'CL-3', 'closed', 'solved')
    setCaseStatus(db, home, 'CL-3', 'open', null)
    expect(getCase(db, 'CL-3')!.phase).toBe('reviewing')
  })

  it('rejects a value that is no longer a lifecycle status', () => {
    mkCase('CL-4')
    expect(() => setCaseStatus(db, home, 'CL-4', 'analyzing' as never, null)).toThrow(
      /Unknown case status/
    )
  })
})
