import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { listFindings, reviewFinding, parseFindingRejectReason, firstNoteLine } from '../findings'
import { writeAttributions, latestAttributionRows } from '../distill/attributions'

let home: string
let db: DatabaseSync
let caseId: number

function seed(
  state: 'pending' | 'accepted' | 'rejected',
  extra: Record<string, unknown> = {}
): number {
  const now = new Date().toISOString()
  const cols = [
    'case_id',
    'session_id',
    'summary',
    'review_state',
    'created_at',
    ...Object.keys(extra)
  ]
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
    const ok = seed('rejected', {
      review_actor: 'human',
      reject_tag: 'wrong',
      reject_note: 'log is from the old build'
    })
    const bad = seed('rejected', { review_actor: 'human', reject_tag: 'vibes', reject_note: 'n' })
    const rows = listFindings(db, home, 'CASE-A')
    expect(rows.find((f) => f.id === ok)).toMatchObject({
      rejectTag: 'wrong',
      rejectNote: 'log is from the old build'
    })
    expect(rows.find((f) => f.id === bad)).toMatchObject({ rejectTag: null, rejectNote: 'n' })
  })
})

describe('reviewFinding with a reason', () => {
  it('stores the tag and the first non-blank line of the note, trimmed to 200 chars', () => {
    const id = seed('pending')
    const row = reviewFinding(db, id, 'rejected', {
      tag: 'wrong',
      note: `\n\n   ${'x'.repeat(250)}\nsecond line`
    })
    expect(row).toMatchObject({ reviewState: 'rejected', reviewActor: 'human', rejectTag: 'wrong' })
    expect(row?.rejectNote).toBe('x'.repeat(200))
  })

  it('a reject with no reason keeps an existing label; a fresh reject lands unlabelled', () => {
    const id = seed('pending')
    reviewFinding(db, id, 'rejected', { tag: 'not-useful' })
    const again = reviewFinding(db, id, 'rejected')
    expect(again?.rejectTag).toBe('not-useful')
    const fresh = reviewFinding(db, seed('pending'), 'rejected')
    expect(fresh?.rejectTag).toBeNull()
    expect(fresh?.rejectNote).toBeNull()
  })

  it('accept and pending clear both columns', () => {
    const id = seed('pending')
    reviewFinding(db, id, 'rejected', { tag: 'other', note: 'n' })
    expect(reviewFinding(db, id, 'accepted')).toMatchObject({ rejectTag: null, rejectNote: null })
    reviewFinding(db, id, 'rejected', { tag: 'other', note: 'n' })
    expect(reviewFinding(db, id, 'pending')).toMatchObject({
      reviewState: 'pending',
      reviewActor: null,
      rejectTag: null,
      rejectNote: null
    })
  })

  it('never writes review_reason: a human reject over an agent retraction keeps the agent text', () => {
    const id = seed('rejected', {
      review_actor: 'agent',
      review_reason: 'the guard is in the caller'
    })
    const row = reviewFinding(db, id, 'rejected', { tag: 'wrong', note: 'human note' })
    expect(row).toMatchObject({
      reviewActor: 'human',
      rejectTag: 'wrong',
      rejectNote: 'human note'
    })
    expect(
      (
        db.prepare(`SELECT review_reason FROM findings WHERE id = ?`).get(id) as {
          review_reason: string
        }
      ).review_reason
    ).toBe('the guard is in the caller')
  })

  it('a `wrong` note naming a case asset overrides that asset to misled; other tags never do', () => {
    const jobId = Number(
      db
        .prepare(
          `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at) VALUES ('CASE-A','done','{}','x')`
        )
        .run().lastInsertRowid
    )
    writeAttributions(db, {
      caseSlug: 'CASE-A',
      jobId,
      verdicts: [
        { kind: 'skill', name: 'diag', applied: true, verdict: 'helped', reason: 'r', cites: [] }
      ],
      tiers: new Map(),
      caseOutcome: 'solved',
      caseDomain: 'NAV',
      judgeModel: 'm',
      promptHash: 'h'
    })
    const overridden: unknown[] = []
    reviewFinding(
      db,
      seed('pending'),
      'rejected',
      { tag: 'not-useful', note: 'diag misled' },
      {
        onOverride: (r) => overridden.push(r)
      }
    )
    expect(overridden).toEqual([])
    reviewFinding(
      db,
      seed('pending'),
      'rejected',
      { tag: 'wrong', note: 'skill:diag misled me' },
      {
        onOverride: (r) => overridden.push(r)
      }
    )
    expect(overridden).toHaveLength(1)
    const rows = latestAttributionRows(db, { caseSlug: 'CASE-A' })
    expect(rows.find((r) => r.assetName === 'diag')).toMatchObject({
      overrideVerdict: 'misled',
      overrideSource: 'finding-reject'
    })
  })

  it('an override failure is logged and never fails the review', () => {
    const id = seed('pending')
    // No distill job on this case: the override path returns null quietly. Force a throw by
    // dropping the table it reads.
    db.exec(`DROP TABLE asset_attributions`)
    const errors: unknown[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => void errors.push(a)
    try {
      const row = reviewFinding(db, id, 'rejected', { tag: 'wrong', note: 'skill:diag' })
      expect(row?.reviewState).toBe('rejected')
    } finally {
      console.error = orig
    }
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('parseFindingRejectReason (IPC boundary)', () => {
  it('passes undefined / null through as undefined', () => {
    expect(parseFindingRejectReason(undefined)).toBeUndefined()
    expect(parseFindingRejectReason(null)).toBeUndefined()
  })
  it('accepts a known tag with or without a string note', () => {
    expect(parseFindingRejectReason({ tag: 'wrong' })).toEqual({ tag: 'wrong' })
    expect(parseFindingRejectReason({ tag: 'other', note: 'n' })).toEqual({
      tag: 'other',
      note: 'n'
    })
  })
  it('throws on an unknown tag, a non-object, or a non-string note', () => {
    expect(() => parseFindingRejectReason({ tag: 'vibes' })).toThrow(/vibes/)
    expect(() => parseFindingRejectReason('wrong')).toThrow(/reject reason/)
    expect(() => parseFindingRejectReason({ tag: 'wrong', note: 7 })).toThrow(/note/)
  })
})

describe('firstNoteLine', () => {
  it('is the proposal rule: first non-blank line, trimmed, 200 chars, null when empty', () => {
    expect(firstNoteLine(undefined)).toBeNull()
    expect(firstNoteLine('  \n\n')).toBeNull()
    expect(firstNoteLine('\r\n  a line \r\nb')).toBe('a line')
    expect(firstNoteLine('y'.repeat(300))).toBe('y'.repeat(200))
  })
})
