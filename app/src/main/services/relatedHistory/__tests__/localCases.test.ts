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
    // summaries survives suppression. All three of `rider`/`bearing`/`north` are
    // non-strong (source 'free'), so none of them can relax overlap regardless
    // of how rare they are — only the overlap count decides.
    pad(11)
    add('rider-a', 'solved', { signature: 'rider seat vibration' })
    add('rider-b', 'solved', { signature: 'rider display flicker' })
    add('victim', 'solved', {
      signature: 'state of charge underflow on the second leg',
      symptoms:
        'A long body about battery state of charge, pack temperature and regenerative braking that happens to mention the rider exactly once.'
    })
    // Pin the WHOLE result, not just `hits`: a suppression rejection carries
    // `reason: 'query-too-generic'` and would fail this exact-equality check,
    // so a fixture shrink that makes Rule 2 the rejector (instead of Rule 3)
    // turns this test red rather than silently passing for the wrong reason.
    const r = await provider().search(freeFormQuery('rider bearing north'), 5)
    expect(r).toEqual({ ok: true, hits: [] })
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

  it('3b. a strong term that is NOT rare does NOT relax overlap on its own', async () => {
    // Rule 3 requires strong-source AND rare (fix pass 2, per coordinator
    // review): a strong term that is common in the corpus is shared
    // vocabulary, not decisive evidence, and still needs a second overlapping
    // term. Here the shared term has df=3 in a 12-summary corpus (threshold
    // 0.3*12=3.6, so it still survives Rule 2) — not rare by any measure
    // (df=3 > RARE_DF=2) — and its only source is a `signature` token, so it
    // WOULD have relaxed under the old (pre-fix-pass-2) `isStrong(term)`-alone
    // rule. It must not relax now.
    pad(9)
    add('alpha', 'solved', { signature: 'brakejitter observed on alpha rig' })
    add('beta', 'solved', { signature: 'brakejitter observed on beta rig' })
    add('gamma', 'solved', { signature: 'brakejitter observed on gamma rig' })
    createCase(db, home, { slug: 'current', title: 'irrelevant' })
    upsertCaseSummary(
      db,
      home,
      'current',
      { signature: 'brakejitter', symptoms: '', rootCause: '', fix: '', keywords: [] },
      'open',
      'md'
    )
    const q = buildRelatedQuery(db, 'current')
    expect(q.terms).toEqual([{ text: 'brakejitter', source: 'signature' }])
    const r = await provider('current').search(q, 5)
    expect(r).toEqual({ ok: true, hits: [] })
  })

  it('3c. a rare jiraKey term relaxes overlap on its own (strong AND rare)', async () => {
    // jiraKey was newly added to the strong set in fix pass 1 — nothing
    // exercised it actually relaxing Rule 3 until now. `current`'s own ticket
    // key is echoed as a `jiraKey`-source query term (buildRelatedQuery, since
    // `current` has no accepted summary); `target`'s summary happens to cite
    // that same key (e.g. a cross-linked ticket) in its keywords, so it is the
    // ONLY summary the term matches — df=1: strong AND rare.
    pad(6)
    add('target', 'solved', {
      signature: 'unrelated symptom text',
      keywords: ['KAN-42']
    })
    createCase(db, home, { slug: 'current', title: 'irrelevant', jiraKey: 'KAN-42' })
    const q = buildRelatedQuery(db, 'current')
    expect(q.terms).toEqual([
      { text: 'irrelevant', source: 'title' },
      { text: 'KAN-42', source: 'jiraKey' }
    ])
    const r = await provider('current').search(q, 5)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hits.map((h) => (h as LocalCaseHit).caseSlug)).toEqual(['target'])
  })

  it('4. open-resolution summaries are excluded', async () => {
    pad(6)
    add('live', 'open', { signature: 'ecu reset drifts dlt timestamps badly' })
    // Pin the full result: this fixture currently rejects via the df===0 path
    // (an open-resolution row contributes to no term's df set at all, so every
    // term is dropped before suppression/overlap even run) — asserting
    // `reason` locks in that this is the guard actually firing here.
    const r = await provider().search(freeFormQuery('ecu reset drifts dlt'), 5)
    expect(r).toEqual({ ok: true, hits: [], reason: 'query-too-generic' })
  })

  it('5. rule 3 is source-blind for rarity — a rare title word must not relax overlap (population 2)', async () => {
    // The spec §1 corpus, shrunk to just the two summaries whose incidental
    // overlap with the sample title actually produced the two false-positive
    // hits (snippets «tour» and «case»). Population 2 is small enough that
    // both terms are df=1 and survive Rule 2 regardless (see
    // DF_SUPPRESS_FLOOR) — Rule 3 is the ONLY guard standing between this
    // corpus and the bug.
    //
    // 'guided' deliberately does not appear in either summary here: if it did,
    // 'routing' would pick up a second, independent overlapping term (guided +
    // tour) and become eligible on legitimate overlap alone, which would no
    // longer isolate the source-blind-rarity defect this test exists to catch.
    createCase(db, home, { slug: SAMPLE_CASE_SLUG, title: SAMPLE_CASE_TITLE })
    add('routing', 'forwarded', {
      signature: 'continuous alternative route flickers on rejoin',
      symptoms: 'seen on typical routes only',
      rootCause: 'compares the alternative tour against a stale main tour'
    })
    add('charge', 'solved', {
      signature: 'charge plan dropped when an alternative is accepted',
      symptoms: 'In this case the SoC prediction resets to the pack maximum'
    })

    const q = buildRelatedQuery(db, SAMPLE_CASE_SLUG)
    const r = await provider(SAMPLE_CASE_SLUG).search(q, 5)
    expect(r).toEqual({ ok: true, hits: [] })
  })

  it('6. rule 3 is source-blind for rarity — a title word rare in a large population must not relax overlap', async () => {
    // 'sample'/'guided'/'case' are common (df ~20, suppressed by Rule 2), but
    // 'tour' appears in exactly ONE summary out of 21 — rare enough that the
    // OLD code's source-blind rarity limb let it through Rule 3 on its own.
    // Rule 2 can never catch this: 'tour' is genuinely rare in this corpus,
    // not merely below the suppression threshold by coincidence of a small
    // population (that configuration is test 5's job).
    createCase(db, home, { slug: SAMPLE_CASE_SLUG, title: SAMPLE_CASE_TITLE })
    for (let i = 0; i < 20; i++) {
      add(`pad-${i}`, 'solved', { signature: `another guided sample case walkthrough ${i}` })
    }
    add('target', 'solved', { signature: 'route diverges after the scenic tour begins' })

    const q = buildRelatedQuery(db, SAMPLE_CASE_SLUG)
    const r = await provider(SAMPLE_CASE_SLUG).search(q, 5)
    expect(r).toEqual({ ok: true, hits: [] })
  })

  it('7. a jiraKey term is exact-matched, not prefixed — a longer key sharing the same prefix must not match', async () => {
    // Measured regression (fix pass 3): FTS5 tokenizes "KAN-4" to [kan, 4]. A
    // PREFIX match ("KAN-4"*) also matches "KAN-42" (tokenized [kan, 42]) —
    // trackers number sequentially, so any case with a short key collides
    // with dozens of later ones. `collateral`'s summary merely CITES an
    // unrelated ticket, KAN-42, in its keywords; `current`'s own key is the
    // shorter KAN-4. Under a prefix match this relaxes (strong AND
    // apparently-rare) and returns collateral as a confident hit. Exact
    // match must find zero — 'irrelevant' is the only other term and it
    // matches nothing.
    pad(6)
    add('collateral', 'solved', {
      signature: 'completely unrelated symptom text',
      keywords: ['KAN-42']
    })
    createCase(db, home, { slug: 'current', title: 'irrelevant', jiraKey: 'KAN-4' })
    const q = buildRelatedQuery(db, 'current')
    expect(q.terms).toEqual([
      { text: 'irrelevant', source: 'title' },
      { text: 'KAN-4', source: 'jiraKey' }
    ])
    const r = await provider('current').search(q, 5)
    expect(r).toEqual({ ok: true, hits: [], reason: 'query-too-generic' })
  })

  it('8. a jiraKey term still matches exactly when the cited key is identical', async () => {
    // The other direction of test 7: switching jiraKey from prefix to exact
    // must not stop it matching a genuine, identical citation.
    pad(6)
    add('target', 'solved', {
      signature: 'completely unrelated symptom text',
      keywords: ['KAN-4']
    })
    createCase(db, home, { slug: 'current', title: 'irrelevant', jiraKey: 'KAN-4' })
    const q = buildRelatedQuery(db, 'current')
    const r = await provider('current').search(q, 5)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hits.map((h) => (h as LocalCaseHit).caseSlug)).toEqual(['target'])
  })

  // SUPERSEDES the fix-pass-3 version of this test, whose premise (a
  // legitimate-looking 2-term overlap arising from 'sample' PREFIX-matching
  // 'sampled') is now structurally impossible: weak (title/finding/free)
  // terms are exact-matched (fix pass 4), so 'sample' can never match
  // 'sampled' at all, at any population. The fix-pass-3 fixture (where
  // 'case' appeared in all 3 summaries, df=3) also no longer isolates the
  // right thing — 'case' there is suppressed by Rule 2 regardless, which
  // proves Rule 2, not the prefix fix. This version keeps BOTH terms at
  // df=1, per the coordinator's re-verified measurement, to isolate the
  // actual fix: exact matching, not suppression, is what stops it.
  it('9. below population 4, a weak title term must not prefix-match a longer word in an unrelated summary', async () => {
    // Coordinator's re-verified measurement (fix pass 4): population 3, an
    // unrelated summary whose symptoms read "In this case the SoC value is
    // sampled once per second". 'case' is df=1 (battery only — alpha/beta
    // deliberately do NOT contain it, unlike the fix-pass-3 fixture) and
    // 'Sample:'->'sample' would have been df=1 too, PREFIX-matching
    // "sampled" (also battery only) — both survive Rule 2's floor (both are
    // rare enough), and both landing on the same summary would satisfy
    // MIN_OVERLAP through genuine-looking overlap. Under exact matching,
    // 'sample' cannot match "sampled" AT ALL (different token) — df=0,
    // dropped by the `df === 0` filter before suppression even runs. 'case'
    // alone survives Rule 2 (df=1, rare) and reaches Rule 3, but a single
    // non-strong term can never relax overlap on its own — so it is Rule 3,
    // not Rule 2, that rejects here (no `reason` attached, same shape as
    // test 3b).
    createCase(db, home, { slug: SAMPLE_CASE_SLUG, title: SAMPLE_CASE_TITLE })
    add('battery', 'solved', {
      signature: 'battery charge regulation issue',
      symptoms: 'In this case the SoC value is sampled once per second'
    })
    add('alpha', 'solved', { signature: 'unrelated alpha thermal symptom' })
    add('beta', 'solved', { signature: 'unrelated beta thermal symptom' })

    const q = buildRelatedQuery(db, SAMPLE_CASE_SLUG)
    const r = await provider(SAMPLE_CASE_SLUG).search(q, 5)
    expect(r).toEqual({ ok: true, hits: [] })
  })

  it('10. a genuine multi-term weak match still returns its hit under exact-only weak matching (over-correction canary)', async () => {
    // The other direction of test 9: switching weak sources from prefix to
    // exact must not stop ordinary multi-word overlap on IDENTICAL words —
    // only morphological-suffix collisions (case/sampled) are the target.
    // 4 title words, each an exact token match in `target`'s signature —
    // no suffix trickery on either side, so this must match exactly as it
    // would have before the fix.
    pad(6)
    add('target', 'solved', { signature: 'wakelock never released on teardown path' })
    createCase(db, home, { slug: 'current', title: 'wakelock never released teardown' })
    const q = buildRelatedQuery(db, 'current')
    expect(q.terms.every((t) => t.source === 'title')).toBe(true)
    const r = await provider('current').search(q, 5)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hits.map((h) => (h as LocalCaseHit).caseSlug)).toEqual(['target'])
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

  // Re-derived for fix pass 3: the old population bypass let ANY term survive
  // Rule 2 below population 4, even one shared by every summary in the corpus
  // — which is exactly how a tiny-corpus false positive (spec §1's "case"/
  // "Sample:"->"sampled") got through. The DF_SUPPRESS_FLOOR replacement still
  // suppresses a term at df=2 in a population of 2 (both summaries share it),
  // but keeps a genuinely rare (df=1) term alive, which is what should still
  // "just match" on a tiny corpus.
  it('keeps a genuinely rare term alive below the minimum population, via the suppression floor', async () => {
    add('a', 'solved', { signature: 'ecu reset drift' })
    add('b', 'solved', { signature: 'unrelated symptom text' })
    const r = await provider().search(freeFormQuery('ecu reset'), 5)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hits.map((h) => (h as LocalCaseHit).caseSlug)).toEqual(['a'])
  })

  it('still suppresses a term shared by every summary in a tiny corpus (the floor is not a bypass)', async () => {
    // Same population (2) as the pre-fix-pass-3 version of the test above, but
    // now both 'ecu' and 'reset' are df=2 (shared by BOTH summaries) — the
    // exact configuration the old bypass let through unsuppressed. The floor
    // (Math.max(population * ratio, 1) = 1) suppresses anything at df >= 2
    // here, same as it would at any larger population.
    add('a', 'solved', { signature: 'ecu reset drift' })
    add('b', 'solved', { signature: 'ecu reset loop' })
    const r = await provider().search(freeFormQuery('ecu reset'), 5)
    expect(r).toEqual({ ok: true, hits: [], reason: 'query-too-generic' })
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
