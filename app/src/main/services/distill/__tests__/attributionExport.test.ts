import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { writeAttributions } from '../attributions'
import { exportAttributions } from '../attributionExport'

describe('exportAttributions', () => {
  it('writes one event per latest-job row, filtered by domain when asked', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-aexp-'))
    const db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'c1', title: 'T' })
    createCase(db, home, { slug: 'c2', title: 'T' })
    const j = (slug: string): number =>
      Number(
        db
          .prepare(
            `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at) VALUES (?,'done','{}','x')`
          )
          .run(slug).lastInsertRowid
      )
    const v = {
      kind: 'skill' as const,
      name: 'diag',
      applied: true,
      verdict: 'helped' as const,
      reason: 'r',
      cites: []
    }
    writeAttributions(db, {
      caseSlug: 'c1',
      jobId: j('c1'),
      verdicts: [v],
      tiers: new Map(),
      caseOutcome: 'solved',
      caseDomain: 'NAV',
      judgeModel: 'm',
      promptHash: 'h'
    })
    writeAttributions(db, {
      caseSlug: 'c2',
      jobId: j('c2'),
      verdicts: [v],
      tiers: new Map(),
      caseOutcome: 'solved',
      caseDomain: 'INFRA',
      judgeModel: 'm',
      promptHash: 'h'
    })
    const out = path.join(home, 'a.ndjson')
    expect(exportAttributions(db, out, { installId: 'i', appVersion: '1' })).toEqual({
      path: out,
      exported: 2
    })
    const lines = fs.readFileSync(out, 'utf8').split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toMatchObject({
      'gen_ai.evaluation.name': 'asset.contribution',
      'argus.case.slug': 'c1',
      'argus.install.id': 'i'
    })
    expect(
      exportAttributions(db, out, { installId: 'i', appVersion: '1' }, { domain: 'INFRA' }).exported
    ).toBe(1)
    expect(fs.readFileSync(out, 'utf8')).toContain('"INFRA"')
    expect(fs.readFileSync(out, 'utf8')).not.toContain('"NAV"')
    // Exact match, not prefix/substring; an empty export is an empty file with no stray newline.
    expect(
      exportAttributions(db, out, { installId: 'i', appVersion: '1' }, { domain: 'INF' }).exported
    ).toBe(0)
    expect(fs.readFileSync(out, 'utf8')).toBe('')
  })
})
