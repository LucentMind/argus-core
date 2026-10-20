import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { writeAttributions } from '../attributions'
import { overrideFromRetraction, overrideFromProposalReject } from '../overrides'

let home: string
let db: DatabaseSync
let caseId: number
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ovr-'))
  db = openDb(path.join(home, 'argus.db'))
  caseId = createCase(db, home, { slug: 'c1', title: 'T' }).id
  const jobId = Number(
    db
      .prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at) VALUES ('c1','done','{}','x')`
      )
      .run().lastInsertRowid
  )
  writeAttributions(db, {
    caseSlug: 'c1',
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
  db.prepare(
    `INSERT INTO findings (id, case_id, summary, review_state, created_at) VALUES (1, ?, 'f', 'pending', 'x')`
  ).run(caseId)
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('overrideFromRetraction', () => {
  it('a reason naming an inventoried asset flips it to misled', () => {
    const row = overrideFromRetraction(db, 1, 'the diag skill pointed at the wrong subsystem')
    expect(row).toMatchObject({
      assetName: 'diag',
      overrideVerdict: 'misled',
      overrideSource: 'finding-retraction'
    })
  })
  it('no mention → null and nothing written', () => {
    expect(overrideFromRetraction(db, 1, 'duplicate of finding 3')).toBeNull()
    expect(db.prepare(`SELECT override_verdict AS o FROM asset_attributions`).get()).toEqual({
      o: null
    })
  })
  it('an unknown finding id → null', () => {
    expect(overrideFromRetraction(db, 999, 'the diag skill was wrong')).toBeNull()
  })
})

describe('overrideFromProposalReject', () => {
  it('wrong/overfit against an inventoried edit target overrides; other reasons and new skills do not', () => {
    expect(
      overrideFromProposalReject(
        db,
        { caseSlug: 'c1', type: 'skill-edit', target: 'diag' },
        { tag: 'wrong' }
      )
    ).toMatchObject({ overrideSource: 'proposal-reject', overrideVerdict: 'misled' })
    expect(
      overrideFromProposalReject(
        db,
        { caseSlug: 'c1', type: 'skill-edit', target: 'diag' },
        { tag: 'overgeneric' }
      )
    ).toBeNull()
    expect(
      overrideFromProposalReject(
        db,
        { caseSlug: 'c1', type: 'skill-new', target: 'brand-new' },
        { tag: 'wrong' }
      )
    ).toBeNull()
    expect(
      overrideFromProposalReject(
        db,
        { caseSlug: 'c1', type: 'reference-edit', target: 'not-in-case.md' },
        { tag: 'overfit' }
      )
    ).toBeNull()
    expect(
      overrideFromProposalReject(
        db,
        { caseSlug: 'c1', type: 'skill-edit', target: 'diag' },
        undefined
      )
    ).toBeNull()
  })
  it('a reference-edit target "limits" matches the inventoried "limits.md"; a nested same-basename file does not (A1)', () => {
    const jobId = Number(
      db
        .prepare(
          `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at) VALUES ('c1','done','{}','y')`
        )
        .run().lastInsertRowid
    )
    writeAttributions(db, {
      caseSlug: 'c1',
      jobId,
      verdicts: [
        {
          kind: 'reference',
          name: 'limits.md',
          applied: true,
          verdict: 'helped',
          reason: 'r',
          cites: []
        },
        {
          kind: 'reference',
          name: 'nav/brakes.md',
          applied: true,
          verdict: 'helped',
          reason: 'r',
          cites: []
        }
      ],
      tiers: new Map(),
      caseOutcome: 'solved',
      caseDomain: 'NAV',
      judgeModel: 'm',
      promptHash: 'h'
    })
    expect(
      overrideFromProposalReject(
        db,
        { caseSlug: 'c1', type: 'reference-edit', target: 'limits' },
        { tag: 'wrong' }
      )
    ).toMatchObject({
      assetKind: 'reference',
      assetName: 'limits.md',
      overrideVerdict: 'misled',
      overrideSource: 'proposal-reject'
    })
    // A reference-edit targets a top-level file only (ASSET_NAME_RE has no separator), so
    // "brakes" edits references/brakes.md — never the nested nav/brakes.md the case read.
    expect(
      overrideFromProposalReject(
        db,
        { caseSlug: 'c1', type: 'reference-edit', target: 'brakes' },
        { tag: 'wrong' }
      )
    ).toBeNull()
  })
})
