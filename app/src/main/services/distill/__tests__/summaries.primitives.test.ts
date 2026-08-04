import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { upsertCaseSummary, summaryPopulation, termSlugSets, rankSlugs } from '../summaries'

let home: string
let db: DatabaseSync

function add(
  slug: string,
  resolution: string,
  s: Partial<Parameters<typeof upsertCaseSummary>[3]> & { signature: string }
): void {
  createCase(db, home, { slug, title: slug })
  upsertCaseSummary(
    db,
    home,
    slug,
    { symptoms: '', rootCause: '', fix: '', keywords: [], ...s },
    resolution,
    'md'
  )
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prim-'))
  db = openDb(path.join(home, 'argus.db'))
})

describe('summaryPopulation', () => {
  it('counts summaries and can exclude the open ones staging writes', () => {
    add('a', 'solved', { signature: 'alpha' })
    add('b', 'open', { signature: 'beta' })
    expect(summaryPopulation(db, false)).toBe(2)
    expect(summaryPopulation(db, true)).toBe(1)
  })
})

describe('termSlugSets', () => {
  beforeEach(() => {
    add('one', 'solved', { signature: 'ecu reset drift', symptoms: 'gaps in the trace' })
    add('two', 'solved', { signature: 'reset loop', symptoms: 'watchdog fires' })
    add('open-one', 'open', { signature: 'ecu live' })
  })

  it('returns one slug set per term, prefix-matched', () => {
    const sets = termSlugSets(db, ['reset', 'watchdog', 'zzz'])
    expect([...sets.get('reset')!].sort()).toEqual(['one', 'two'])
    expect([...sets.get('watchdog')!]).toEqual(['two'])
    expect(sets.get('zzz')!.size).toBe(0)
  })

  it('excludes open-resolution summaries by default and the named slug', () => {
    expect([...termSlugSets(db, ['ecu']).get('ecu')!]).toEqual(['one'])
    expect(termSlugSets(db, ['ecu'], { excludeOpen: false }).get('ecu')!.size).toBe(2)
    expect(termSlugSets(db, ['reset'], { excludeSlug: 'one' }).get('reset')!.size).toBe(1)
  })

  it('a quote-heavy term still round-trips to a valid (zero-match) FTS5 query', () => {
    // prefixTerm quotes every character (doubling internal `"`), so there is no
    // *term* string that becomes invalid FTS5 syntax — '"""' parses to a quoted
    // phrase-prefix that simply matches nothing. termSlugSets has no per-term
    // catch: a real throw here (a broken index) is meant to propagate.
    const sets = termSlugSets(db, ['"""', 'reset'])
    expect(sets.get('"""')!.size).toBe(0)
    expect(sets.get('reset')!.size).toBe(2)
  })

  it('surfaces a broken index as a throw rather than swallowing it to empty sets', () => {
    // Dropping the whole virtual table would fail at db.prepare(), before any
    // per-term catch could even run — not discriminating. Dropping only its
    // fts5 shadow table leaves `db.prepare` succeeding (the virtual table
    // declaration is still there) and pushes the failure into `stmt.all()`
    // inside the per-term loop, which is the actual case the removed catch
    // used to swallow.
    db.exec('DROP TABLE case_summaries_fts_data')
    expect(() => termSlugSets(db, ['reset'])).toThrow()
  })
})

describe('rankSlugs', () => {
  beforeEach(() => {
    add('one', 'solved', {
      signature: 'ecu reset drift',
      symptoms: 'gaps in the trace',
      rootCause: 'clock resync',
      fix: 'ignore first 2s',
      keywords: ['dlt', 'ecu-reset']
    })
    add('two', 'solved', { signature: 'reset loop' })
  })

  it('ranks only the given slugs and carries the full distilled row plus jiraKey', () => {
    const rows = rankSlugs(db, ['reset'], ['one'], 5)
    expect(rows.map((r) => r.caseSlug)).toEqual(['one'])
    expect(rows[0].rootCause).toBe('clock resync')
    expect(rows[0].fix).toBe('ignore first 2s')
    expect(JSON.parse(rows[0].keywords)).toEqual(['dlt', 'ecu-reset'])
    expect(rows[0].resolution).toBe('solved')
    expect(rows[0].jiraKey).toBeNull()
    expect(rows[0].snippet).toContain('«')
  })

  it('honours the limit and returns [] for empty inputs', () => {
    expect(rankSlugs(db, ['reset'], ['one', 'two'], 1)).toHaveLength(1)
    expect(rankSlugs(db, ['reset'], [], 5)).toEqual([])
    expect(rankSlugs(db, [], ['one'], 5)).toEqual([])
  })

  it('surfaces a broken index as a throw rather than swallowing it', () => {
    // prefixTerm's quoting escapes every character, so no *term* string can ever
    // produce invalid FTS5 syntax (verified: '"""' round-trips to a valid quoted
    // phrase-prefix and matches zero rows, it does not throw). The failure mode
    // rankSlugs must surface per spec §4.6 is a genuinely broken index instead.
    db.exec('DROP TABLE case_summaries_fts')
    expect(() => rankSlugs(db, ['reset'], ['one'], 5)).toThrow()
  })
})
