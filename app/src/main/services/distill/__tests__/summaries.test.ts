import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { caseDir } from '../../paths'
import {
  upsertCaseSummary,
  getCaseSummary,
  searchCaseSummaries,
  similarCases,
  renderSummaryMarkdown
} from '../summaries'

const SUM = {
  signature: 'ECU reset drifts DLT timestamps',
  symptoms: 'gaps in trace',
  rootCause: 'clock resync',
  fix: 'ignore first 2s',
  keywords: ['dlt', 'ecu-reset']
}

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'old-case', title: 'DLT timestamp drift after ECU reset' })
  createCase(db, home, { slug: 'new-case', title: 'DLT timestamps wrong after reset' })
})

describe('case summaries', () => {
  it('upsert writes row, fts, and summary.md; re-upsert replaces', () => {
    const md = renderSummaryMarkdown(SUM, {
      slug: 'old-case',
      title: 'T',
      jiraKey: null,
      resolution: 'solved'
    })
    upsertCaseSummary(db, home, 'old-case', SUM, 'solved', md)
    upsertCaseSummary(db, home, 'old-case', { ...SUM, signature: 'v2 sig' }, 'solved', md)
    const rec = getCaseSummary(db, 'old-case')!
    expect(rec.signature).toBe('v2 sig')
    expect(rec.keywords).toEqual(['dlt', 'ecu-reset'])
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM case_summaries_fts WHERE case_slug = 'old-case'`).get()
    ).toEqual({ n: 1 })
    expect(fs.existsSync(path.join(caseDir(home, 'old-case'), 'summary.md'))).toBe(true)
  })

  it('search matches signature text and excludes a slug', () => {
    upsertCaseSummary(db, home, 'old-case', SUM, 'solved', '# s')
    expect(searchCaseSummaries(db, 'DLT drift')[0].caseSlug).toBe('old-case')
    expect(searchCaseSummaries(db, 'DLT drift', { excludeSlug: 'old-case' })).toEqual([])
    expect(searchCaseSummaries(db, '"""')).toEqual([]) // syntax garbage → []
  })

  it('similarCases queries by the new case title, excluding itself', () => {
    upsertCaseSummary(db, home, 'old-case', SUM, 'solved', '# s')
    const hits = similarCases(db, 'new-case')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ caseSlug: 'old-case', resolution: 'solved' })
  })

  it('tolerates punctuation that would otherwise be raw FTS5 syntax', () => {
    upsertCaseSummary(db, home, 'old-case', SUM, 'solved', '# s')
    const hits = searchCaseSummaries(db, 'reset(): timestamps DLT')
    expect(hits).not.toEqual([])
    expect(hits[0].caseSlug).toBe('old-case')
  })

  it('neutralizes a column-filter-shaped token instead of silently scoping', () => {
    upsertCaseSummary(db, home, 'old-case', SUM, 'solved', '# s')
    expect(() => searchCaseSummaries(db, 'fix: dlt')).not.toThrow()
    const hits = searchCaseSummaries(db, 'fix: dlt')
    expect(hits).not.toEqual([])
    expect(hits[0].caseSlug).toBe('old-case')
  })

  it('snippet reflects whichever column actually matched, not always column 0', () => {
    upsertCaseSummary(
      db,
      home,
      'old-case',
      { ...SUM, symptoms: 'wakelock held during suspend' },
      'solved',
      '# s'
    )
    const hits = searchCaseSummaries(db, 'wakelock')
    expect(hits).not.toEqual([])
    expect(hits[0].snippet).toContain('«wakelock»')
  })
})
