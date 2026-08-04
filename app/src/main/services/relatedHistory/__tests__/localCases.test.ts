import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { upsertCaseSummary } from '../../distill/summaries'
import { createLocalCasesProvider } from '../providers/localCases'
import type { HistoryProvider } from '../types'
import { buildRelatedQuery, freeFormQuery } from '../query'
import type { LocalCaseHit } from '../../../../shared/relatedHistory'
import { SAMPLE_CASE_SLUG, SAMPLE_CASE_TITLE } from '../../../../shared/onboarding'

let home: string
let db: DatabaseSync

function add(
  slug: string,
  resolution: string,
  s: {
    signature: string
    symptoms?: string
    rootCause?: string
    fix?: string
    keywords?: string[]
  },
  jiraKey?: string
): void {
  createCase(db, home, { slug, title: slug, ...(jiraKey ? { jiraKey } : {}) })
  upsertCaseSummary(
    db,
    home,
    slug,
    { symptoms: '', rootCause: '', fix: '', keywords: [], ...s },
    resolution,
    'md'
  )
}

/** Enough padding rows that df suppression is active (population >= 4) and a
 *  term in 1 of N rows is below the 30% threshold. */
function pad(n: number): void {
  for (let i = 0; i < n; i++) add(`pad-${i}`, 'solved', { signature: `unrelated padding ${i}` })
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-local-'))
  db = openDb(path.join(home, 'argus.db'))
})

const provider = (excludeSlug: string | null = null): HistoryProvider =>
  createLocalCasesProvider(db, excludeSlug)

describe('local provider — regression tests for the spec §1 defect', () => {
  it('1. the seeded sample case yields query-too-generic and zero hits', async () => {
    createCase(db, home, { slug: SAMPLE_CASE_SLUG, title: SAMPLE_CASE_TITLE })
    // A corpus where every sample-title token is either absent or too common.
    add('routing', 'forwarded', {
      signature: 'continuous alternative route flickers on rejoin',
      symptoms: 'seen on guided routes only',
      rootCause: 'compares the alternative tour against a stale main tour'
    })
    add('charge', 'solved', {
      signature: 'charge plan dropped when an alternative is accepted',
      symptoms: 'In this case the SoC prediction resets to the pack maximum'
    })
    add('third', 'solved', { signature: 'unrelated tour of the case guided sample' })
    add('fourth', 'solved', { signature: 'another case tour guided sample' })

    const q = buildRelatedQuery(db, SAMPLE_CASE_SLUG)
    const r = await provider(SAMPLE_CASE_SLUG).search(q, 5)
    expect(r).toEqual({ ok: true, hits: [], reason: 'query-too-generic' })
  })

  it('2. one incidental word is rejected by the overlap rule', async () => {
    // 14 summaries, so the suppression threshold is 0.3 * 14 = 4.2: a term in 3
    // summaries survives suppression AND sits above RARE_DF. That is the only
    // configuration in which the OVERLAP rule is the deciding guard — below ~10
    // summaries the threshold falls to or under RARE_DF, so every surviving term
    // relaxes overlap to 1. See the small-corpus note on RARE_DF.
    pad(11)
    add('rider-a', 'solved', { signature: 'rider seat vibration' })
    add('rider-b', 'solved', { signature: 'rider display flicker' })
    add('victim', 'solved', {
      signature: 'state of charge underflow on the second leg',
      symptoms:
        'A long body about battery state of charge, pack temperature and regenerative braking that happens to mention the rider exactly once.'
    })
    const r = await provider().search(freeFormQuery('rider bearing north'), 5)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hits).toEqual([])
  })

  it('3. a rare verbatim error string matches on its own', async () => {
    pad(6)
    add('target', 'solved', {
      signature: 'timeout on cold boot',
      keywords: ['E_TIMEOUT_42']
    })
    createCase(db, home, { slug: 'current', title: 'irrelevant' })
    upsertCaseSummary(
      db,
      home,
      'current',
      { signature: 'zzz', symptoms: '', rootCause: '', fix: '', keywords: ['E_TIMEOUT_42'] },
      'open',
      'md'
    )
    const q = buildRelatedQuery(db, 'current')
    const r = await provider('current').search(q, 5)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hits.map((h) => (h as LocalCaseHit).caseSlug)).toEqual(['target'])
  })

  it('4. open-resolution summaries are excluded', async () => {
    pad(6)
    add('live', 'open', { signature: 'ecu reset drifts dlt timestamps badly' })
    const r = await provider().search(freeFormQuery('ecu reset drifts dlt'), 5)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hits).toEqual([])
  })
})

describe('local provider — shape and behaviour', () => {
  it('builds a LocalCaseHit with 1-based rank, provenance, status and distilled', async () => {
    pad(6)
    add(
      'hit',
      'forwarded',
      {
        signature: 'ecu reset drifts dlt timestamps',
        symptoms: 'gaps in trace',
        rootCause: 'clock resync',
        fix: 'ignore first 2s',
        keywords: ['dlt']
      },
      'NAV-9'
    )
    const r = await provider().search(freeFormQuery('ecu reset drifts dlt'), 5)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const h = r.hits[0] as LocalCaseHit
    expect(h.kind).toBe('local')
    expect(h.id).toBe('local:hit')
    expect(h.caseSlug).toBe('hit')
    expect(h.jiraKey).toBe('NAV-9')
    expect(h.rank).toBe(1)
    expect(h.matchedOn).toBe('lexical')
    expect(h.provenance).toEqual([
      { providerId: 'local', providerName: 'Your cases', kind: 'local' }
    ])
    expect(h.status).toEqual({ label: 'forwarded', tone: 'forwarded' })
    expect(h.distilled).toEqual({
      signature: 'ecu reset drifts dlt timestamps',
      symptoms: 'gaps in trace',
      rootCause: 'clock resync',
      fix: 'ignore first 2s',
      terms: ['dlt']
    })
    expect(h.title).toBe('ecu reset drifts dlt timestamps')
  })

  it('skips the df rule below the minimum population so a tiny corpus still matches', async () => {
    add('a', 'solved', { signature: 'ecu reset drift' })
    add('b', 'solved', { signature: 'ecu reset loop' })
    const r = await provider().search(freeFormQuery('ecu reset'), 5)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hits).toHaveLength(2)
  })

  it('honours the limit and excludes the current case', async () => {
    pad(6)
    add('x', 'solved', { signature: 'ecu reset drifts dlt' })
    add('y', 'solved', { signature: 'ecu reset drifts dlt too' })
    const capped = await provider().search(freeFormQuery('ecu reset drifts dlt'), 1)
    expect(capped.ok && capped.hits).toHaveLength(1)
    const excluded = await provider('x').search(freeFormQuery('ecu reset drifts dlt'), 5)
    expect(excluded.ok && excluded.hits.map((h) => (h as LocalCaseHit).caseSlug)).toEqual(['y'])
  })

  it('returns query-too-generic for an empty query', async () => {
    pad(6)
    const r = await provider().search({ text: '', terms: [] }, 5)
    expect(r).toEqual({ ok: true, hits: [], reason: 'query-too-generic' })
  })

  it('reports an index failure instead of swallowing it to []', async () => {
    pad(6)
    db.exec('DROP TABLE case_summaries_fts')
    const r = await provider().search(freeFormQuery('ecu reset'), 5)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeTruthy()
  })
})
