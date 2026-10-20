import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import {
  writeAttributions,
  latestAttributionRows,
  applyAttributionOverride,
  assetNamesForCase,
  lastSessionIdForCase
} from '../attributions'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-attr-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'T' })
})
function job(slug: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at) VALUES (?, 'done', '{}', 'x')`
      )
      .run(slug).lastInsertRowid
  )
}
const V = {
  kind: 'skill' as const,
  name: 'diag',
  applied: true,
  verdict: 'helped' as const,
  reason: 'r',
  cites: [{ finding: 1 }]
}
const base = (jobId: number): Parameters<typeof writeAttributions>[1] => ({
  caseSlug: 'c1',
  jobId,
  verdicts: [V],
  tiers: new Map([['skill/diag', 'user']]),
  caseOutcome: 'solved' as const,
  caseDomain: 'NAV',
  judgeModel: 'm',
  promptHash: 'h',
  now: () => new Date('2026-10-20T00:00:00.000Z')
})

describe('writeAttributions + latestAttributionRows', () => {
  it('writes one row per verdict with tier, outcome, domain and null-able applied/verdict', () => {
    const rows = writeAttributions(db, {
      ...base(job('c1')),
      verdicts: [V, { ...V, name: 'other', applied: null, verdict: null, reason: '', cites: [] }]
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      caseSlug: 'c1',
      assetKind: 'skill',
      assetName: 'diag',
      assetTier: 'user',
      applied: true,
      verdict: 'helped',
      caseOutcome: 'solved',
      caseDomain: 'NAV',
      judgeModel: 'm',
      promptHash: 'h',
      overrideVerdict: null,
      createdAt: '2026-10-20T00:00:00.000Z'
    })
    expect(rows[1]).toMatchObject({
      assetName: 'other',
      assetTier: null,
      applied: null,
      verdict: null
    })
  })
  it('latest job per case wins; older rows are kept, not deleted', () => {
    writeAttributions(db, base(job('c1')))
    writeAttributions(db, { ...base(job('c1')), verdicts: [{ ...V, verdict: 'misled' }] })
    const latest = latestAttributionRows(db)
    expect(latest).toHaveLength(1)
    expect(latest[0].verdict).toBe('misled')
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM asset_attributions`).get() as { n: number }).n
    ).toBe(2)
  })
  it('deleting the case cascades', () => {
    writeAttributions(db, base(job('c1')))
    db.prepare(`DELETE FROM cases WHERE slug = 'c1'`).run()
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM asset_attributions`).get() as { n: number }).n
    ).toBe(0)
  })
})

describe('applyAttributionOverride', () => {
  it('stamps the latest-job row, is idempotent, never clears the judge verdict', () => {
    writeAttributions(db, base(job('c1')))
    const r1 = applyAttributionOverride(db, {
      caseSlug: 'c1',
      kind: 'skill',
      name: 'diag',
      verdict: 'misled',
      source: 'finding-retraction',
      now: () => new Date('2026-10-21T00:00:00.000Z')
    })
    expect(r1).toMatchObject({
      verdict: 'helped',
      overrideVerdict: 'misled',
      overrideSource: 'finding-retraction',
      overrideAt: '2026-10-21T00:00:00.000Z'
    })
    const r2 = applyAttributionOverride(db, {
      caseSlug: 'c1',
      kind: 'skill',
      name: 'diag',
      verdict: 'misled',
      source: 'finding-retraction',
      now: () => new Date('2026-10-22T00:00:00.000Z')
    })
    expect(r2?.overrideAt).toBe('2026-10-21T00:00:00.000Z')
  })
  it('creates an applied=1, verdict=NULL row when the judge was silent or absent', () => {
    const j = job('c1')
    const r = applyAttributionOverride(db, {
      caseSlug: 'c1',
      kind: 'reference',
      name: 'x.md',
      verdict: 'misled',
      source: 'proposal-reject'
    })
    expect(r).toMatchObject({
      jobId: j,
      applied: true,
      verdict: null,
      overrideVerdict: 'misled',
      caseDomain: 'unassigned'
    })
    expect(
      applyAttributionOverride(db, {
        caseSlug: 'nope',
        kind: 'skill',
        name: 'a',
        verdict: 'misled',
        source: 'proposal-reject'
      })
    ).toBeNull()
  })
  it('an override on a silent judge row (applied NULL) marks it applied so aggregation counts it', () => {
    writeAttributions(db, {
      ...base(job('c1')),
      verdicts: [{ ...V, applied: null, verdict: null, reason: '', cites: [] }]
    })
    const r = applyAttributionOverride(db, {
      caseSlug: 'c1',
      kind: 'skill',
      name: 'diag',
      verdict: 'misled',
      source: 'finding-retraction'
    })
    expect(r).toMatchObject({
      applied: true,
      verdict: null,
      overrideVerdict: 'misled',
      overrideSource: 'finding-retraction'
    })
  })
})

describe('assetNamesForCase + lastSessionIdForCase', () => {
  it('unions attribution rows with live tool_calls activations', () => {
    const caseId = (db.prepare(`SELECT id FROM cases WHERE slug='c1'`).get() as { id: number }).id
    db.prepare(
      `INSERT INTO sessions (id, case_id, created_at, updated_at) VALUES (5, ?, 'x', 'x'), (6, ?, 'x', 'x')`
    ).run(caseId, caseId)
    db.prepare(
      `INSERT INTO tool_calls (case_id, session_id, tool, args_hash, detail, risk, decision, created_at) VALUES (?, 5, 'Read', 'h', 'ref:nav/limits.md', 'LOW', 'auto', 'x')`
    ).run(caseId)
    writeAttributions(db, base(job('c1')))
    expect(assetNamesForCase(db, 'c1')).toEqual([
      { kind: 'skill', name: 'diag' },
      { kind: 'reference', name: 'nav/limits.md' }
    ])
    expect(lastSessionIdForCase(db, 'c1')).toBe(6)
    expect(lastSessionIdForCase(db, 'nope')).toBeNull()
  })
})
