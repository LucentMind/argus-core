// app/src/main/services/autonomy/__tests__/lanes.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { laneMetrics, listDecisions, timeInTriage } from '../lanes'
import type { LaneDeps } from '../lanes'

let home: string
let db: DatabaseSync
const NOW = new Date('2026-08-12T12:00:00Z')
const deps = (): LaneDeps => ({ db, argusHome: home, now: () => NOW })

function seedCase(slug: string, over: Record<string, unknown> = {}): number {
  const cols = {
    slug,
    title: slug,
    status: 'open',
    origin: 'user',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over
  } as Record<string, string>
  const keys = Object.keys(cols)
  db.prepare(`INSERT INTO cases (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(
    ...keys.map((k) => cols[k])
  )
  const row = db.prepare(`SELECT id FROM cases WHERE slug = ?`).get(slug) as { id: number }
  return row.id
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-lanes-'))
  db = openDb(path.join(home, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('triage lane', () => {
  it('splits accept vs dismiss and windows on triaged_at', () => {
    seedCase('r1', {
      origin: 'routine',
      triaged_at: '2026-08-10T00:00:00.000Z',
      review_state: null
    })
    seedCase('r2', {
      origin: 'routine',
      triaged_at: '2026-08-11T00:00:00.000Z',
      review_state: 'draft',
      status: 'closed',
      resolution: 'rejected'
    })
    seedCase('r3', {
      origin: 'routine',
      triaged_at: '2026-05-01T00:00:00.000Z',
      review_state: null
    }) // outside 30d
    seedCase('r4', { origin: 'routine' }) // undecided draft — not a decision
    seedCase('u1', { origin: 'user', triaged_at: '2026-08-10T00:00:00.000Z' }) // wrong origin

    const m = laneMetrics(deps(), 'triage', 30)
    expect(m.decisions).toBe(2)
    expect(m.accepted).toBe(1)
    expect(m.acceptanceRate).toBeCloseTo(0.5)
    const all = laneMetrics(deps(), 'triage', null)
    expect(all.decisions).toBe(3)
    expect(all.dataStart).toBe('2026-05-01T00:00:00.000Z')
  })

  it('does not retroactively reject an accepted case that a later routine run re-drafted', () => {
    // Accepted once (triaged_at stamped, review_state cleared), then a subsequent routine run
    // re-set review_state='draft' without going through dismiss — status stays 'open'. That
    // must still count as accepted: rejection requires the case to actually be closed.
    seedCase('r5', {
      origin: 'routine',
      triaged_at: '2026-08-10T00:00:00.000Z',
      review_state: 'draft',
      status: 'open'
    })
    const rows = listDecisions(deps(), 'triage', 30)
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('accepted')
  })
})

describe('distill lane', () => {
  it('reads archived proposals, windows on decided, tallies reject reasons', () => {
    const dir = path.join(home, 'proposals', 'archive')
    fs.mkdirSync(dir, { recursive: true })
    const fm = (status: string, extra = ''): string =>
      `---\ntype: skill-new\ntarget: t\ncase: c1\ndate: 2026-08-01\ntitle: x\nstatus: ${status}${extra}\n---\nbody\n`
    fs.writeFileSync(path.join(dir, 'a.md'), fm('accepted', '\ndecided: 2026-08-10T00:00:00.000Z'))
    fs.writeFileSync(
      path.join(dir, 'b.md'),
      fm('rejected', '\ndecided: 2026-08-11T00:00:00.000Z\nreject_reason: overfit')
    )
    fs.writeFileSync(path.join(dir, 'c.md'), fm('accepted')) // pre-stamp: all-time only

    const m = laneMetrics(deps(), 'distill', 30)
    expect(m.decisions).toBe(2)
    expect(m.rejectReasons).toEqual({ overfit: 1 })
    expect(m.costUsd).toBeNull()
    expect(laneMetrics(deps(), 'distill', null).decisions).toBe(3)
  })
})

describe('review-finding lane', () => {
  it('only counts review-mode decided findings and reports depth', () => {
    const caseId = seedCase('c1')
    db.prepare(
      `INSERT INTO sessions (id, case_id, mode, created_at, updated_at) VALUES (1, ?, 'review', ?, ?)`
    ).run(caseId, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    db.prepare(
      `INSERT INTO sessions (id, case_id, mode, created_at, updated_at) VALUES (2, ?, 'investigation', ?, ?)`
    ).run(caseId, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    const f = (
      sid: number,
      state: string,
      at: string | null,
      extra: Record<string, string | null> = {}
    ): void => {
      db.prepare(
        `INSERT INTO findings (case_id, session_id, summary, review_state, reviewed_at, created_at, posted_at, pushed_at)
         VALUES (?, ?, 's', ?, ?, '2026-08-01T00:00:00.000Z', ?, ?)`
      ).run(caseId, sid, state, at, extra.posted ?? null, extra.pushed ?? null)
    }
    f(1, 'accepted', '2026-08-10T00:00:00.000Z', { posted: '2026-08-10T01:00:00.000Z' })
    f(1, 'rejected', '2026-08-11T00:00:00.000Z')
    f(1, 'pending', null) // undecided
    f(2, 'accepted', '2026-08-10T00:00:00.000Z') // investigation mode — excluded

    const m = laneMetrics(deps(), 'review-finding', 30)
    expect(m.decisions).toBe(2)
    expect(m.accepted).toBe(1)
    expect(m.depth.posted).toBe(1)
    expect(m.depth.applied).toBe(0)
  })
})

describe('rca lane', () => {
  it('confirmed=accepted, superseded-unconfirmed=rejected, newest-unconfirmed=pending', () => {
    db.prepare(
      `INSERT INTO rca_jobs (id, case_slug, state, input_snapshot, confirmed_at, created_at, finished_at)
       VALUES (1, 'c1', 'done', '{}', NULL, '2026-08-09T00:00:00.000Z', '2026-08-09T01:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO rca_jobs (id, case_slug, state, input_snapshot, confirmed_at, created_at, finished_at)
       VALUES (2, 'c1', 'done', '{}', '2026-08-10T00:00:00.000Z', '2026-08-09T02:00:00.000Z', '2026-08-09T03:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO rca_jobs (id, case_slug, state, input_snapshot, confirmed_at, created_at, finished_at)
       VALUES (3, 'c2', 'done', '{}', NULL, '2026-08-11T00:00:00.000Z', '2026-08-11T01:00:00.000Z')`
    ).run()
    const rows = listDecisions(deps(), 'rca', 30)
    expect(rows.map((r) => [r.sourceId, r.outcome])).toEqual([
      ['1', 'rejected'],
      ['2', 'accepted']
    ])
    const m = laneMetrics(deps(), 'rca', 30)
    expect(m.depth.generated).toBe(3)
    expect(m.depth.confirmed).toBe(1)
  })
})

describe('timeInTriage', () => {
  it('uses ticket created → first root-cause finding, fallback rca confirm', () => {
    const c1 = seedCase('t1', { jira_key: 'NAV-1' })
    const evDir = path.join(home, 'cases', 't1', 'evidence')
    fs.mkdirSync(evDir, { recursive: true })
    fs.writeFileSync(
      path.join(evDir, 'NAV-1.ticket.json'),
      JSON.stringify({ fields: { created: '2026-08-01T00:00:00.000Z' } })
    )
    db.prepare(
      `INSERT INTO findings (case_id, summary, review_state, created_at, role)
       VALUES (?, 's', 'accepted', '2026-08-03T00:00:00.000Z', 'root-cause')`
    ).run(c1)
    seedCase('t2') // no hypothesis — excluded
    const t = timeInTriage(deps(), 30)
    expect(t.cases).toBe(1)
    expect(t.medianMs).toBe(2 * 24 * 3600 * 1000)
  })
})
