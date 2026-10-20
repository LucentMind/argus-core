// app/src/shared/__tests__/attribution.test.ts
import { describe, it, expect } from 'vitest'
import {
  aggregateAttributions,
  effectiveVerdict,
  matchAssetMention,
  toAttributionEvent,
  MIN_APPLIED,
  type AttributionRow
} from '../attribution'

let seq = 0
function row(over: Partial<AttributionRow>): AttributionRow {
  seq++
  return {
    id: seq,
    caseId: seq,
    caseSlug: `c${seq}`,
    jobId: seq,
    assetKind: 'skill',
    assetName: 'diag',
    assetTier: 'user',
    applied: true,
    verdict: 'helped',
    reason: 'r',
    cites: [{ finding: 1 }],
    caseOutcome: 'solved',
    caseDomain: 'NAV',
    judgeModel: 'm',
    promptHash: 'h',
    overrideVerdict: null,
    overrideSource: null,
    overrideAt: null,
    createdAt: `2026-10-0${(seq % 9) + 1}T00:00:00.000Z`,
    ...over
  }
}

describe('effectiveVerdict', () => {
  it('an override wins over the judge; otherwise the judge', () => {
    expect(effectiveVerdict({ verdict: 'helped', overrideVerdict: 'misled' })).toBe('misled')
    expect(effectiveVerdict({ verdict: 'helped', overrideVerdict: null })).toBe('helped')
    expect(effectiveVerdict({ verdict: null, overrideVerdict: null })).toBeNull()
  })
})

describe('aggregateAttributions', () => {
  it('counts applied/helped/neutral/misled/silent per asset with overrides applied', () => {
    const rows = [
      row({}),
      row({ verdict: 'neutral' }),
      row({ verdict: 'helped', overrideVerdict: 'misled' }),
      row({ applied: null, verdict: null }),
      row({ applied: false, verdict: null })
    ]
    const [a] = aggregateAttributions(rows)
    expect(a).toMatchObject({
      kind: 'skill',
      name: 'diag',
      applied: 3,
      helped: 1,
      neutral: 1,
      misled: 1,
      silent: 1
    })
    expect(a.helpedRate).toBeCloseTo(1 / 3)
  })
  it(`helpedRate is null under MIN_APPLIED (${MIN_APPLIED})`, () => {
    const [a] = aggregateAttributions([row({}), row({})])
    expect(a.applied).toBe(2)
    expect(a.helpedRate).toBeNull()
  })
  it('emergent domains: helped > misled and applied ≥ MIN_APPLIED, per domain', () => {
    const rows = [
      row({ caseDomain: 'NAV' }),
      row({ caseDomain: 'NAV' }),
      row({ caseDomain: 'NAV', verdict: 'misled' }),
      row({ caseDomain: 'INFRA', verdict: 'misled' }),
      row({ caseDomain: 'INFRA', verdict: 'misled' }),
      row({ caseDomain: 'INFRA' }),
      row({ caseDomain: 'TINY' })
    ]
    const [a] = aggregateAttributions(rows)
    expect(a.emergentDomains).toEqual(['NAV'])
    expect(a.byDomain.INFRA).toMatchObject({ applied: 3, helped: 1, misled: 2 })
    expect(a.byDomain.TINY.applied).toBe(1)
  })
  it('outcome distribution counts only applied rows; lastAppliedAt is the max createdAt among applied', () => {
    const rows = [
      row({ caseOutcome: 'solved', createdAt: '2026-10-05T00:00:00.000Z' }),
      row({ caseOutcome: 'handed-off', createdAt: '2026-10-09T00:00:00.000Z' }),
      row({
        applied: false,
        verdict: null,
        caseOutcome: 'rejected',
        createdAt: '2026-10-20T00:00:00.000Z'
      })
    ]
    const [a] = aggregateAttributions(rows)
    expect(a.outcomes).toEqual({ solved: 1, 'handed-off': 1 })
    expect(a.lastAppliedAt).toBe('2026-10-09T00:00:00.000Z')
  })
  it('groups by kind+name, sorted by helpedRate desc then name; tier taken from the newest row', () => {
    const rows = [
      row({ assetName: 'b', assetTier: 'bundled', createdAt: '2026-10-01T00:00:00.000Z' }),
      row({ assetName: 'b', assetTier: null, createdAt: '2026-10-02T00:00:00.000Z' }),
      // Pinned older than both: the default createdAt depends on the module counter and could
      // make this row the newest, which would make the tier assertion below vacuous.
      row({ assetName: 'b', verdict: 'misled', createdAt: '2026-09-30T00:00:00.000Z' }),
      row({ assetName: 'a' }),
      row({ assetName: 'a' }),
      row({ assetName: 'a' }),
      row({ assetKind: 'reference', assetName: 'a' })
    ]
    const out = aggregateAttributions(rows)
    expect(out.map((o) => `${o.kind}/${o.name}`)).toEqual(['skill/a', 'skill/b', 'reference/a'])
    expect(out[1].tier).toBeNull()
  })
})

describe('toAttributionEvent', () => {
  it('maps a row to the gen_ai.evaluation.result shape with score 1/0/-1/null', () => {
    const e = toAttributionEvent(row({ verdict: 'misled' }), {
      installId: 'i',
      appVersion: '2.5.0'
    })
    expect(e['gen_ai.evaluation.name']).toBe('asset.contribution')
    expect(e['gen_ai.evaluation.score.value']).toBe(-1)
    expect(e['gen_ai.evaluation.score.label']).toBe('misled')
    expect(e['argus.asset.name']).toBe('diag')
    expect(e['argus.install.id']).toBe('i')
    expect(e['argus.override.source']).toBeUndefined()
    const silent = toAttributionEvent(row({ applied: null, verdict: null }), {
      installId: 'i',
      appVersion: 'v'
    })
    expect(silent['gen_ai.evaluation.score.value']).toBeNull()
    expect(silent['gen_ai.evaluation.score.label']).toBe('silent')
    const ov = toAttributionEvent(
      row({ overrideVerdict: 'misled', overrideSource: 'proposal-reject' }),
      { installId: 'i', appVersion: 'v' }
    )
    expect(ov['gen_ai.evaluation.score.value']).toBe(-1)
    expect(ov['argus.override.source']).toBe('proposal-reject')
  })
})

describe('matchAssetMention', () => {
  const names = [
    { kind: 'skill' as const, name: 'diagnose-x' },
    { kind: 'reference' as const, name: 'nav/limits.md' }
  ]
  it('matches a bare name, a skill: token and a ref: token; longest match wins; case-insensitive', () => {
    expect(matchAssetMention('the diagnose-x skill sent me down a wrong path', names)).toEqual(
      names[0]
    )
    expect(matchAssetMention('misled by skill:diagnose-x', names)).toEqual(names[0])
    expect(matchAssetMention('ref:nav/limits.md is stale', names)).toEqual(names[1])
    expect(matchAssetMention('DIAGNOSE-X again', names)).toEqual(names[0])
  })
  it('null when nothing matches or on a partial-word hit', () => {
    expect(matchAssetMention('no asset here', names)).toBeNull()
    expect(matchAssetMention('diagnose-xy', names)).toBeNull()
  })
  it('escapes regex metacharacters: "." in a ref name is literal, not a wildcard', () => {
    expect(matchAssetMention('navXlimitsYmd', names)).toBeNull()
    // "." unescaped would match the X here; the literal ref name must not.
    expect(matchAssetMention('nav/limitsXmd is stale', [names[1]])).toBeNull()
    expect(matchAssetMention('nav/limits.md is stale', [names[1]])).toEqual(names[1])
  })
  it('treats regex metacharacters in a name literally', () => {
    const cpp = [{ kind: 'skill' as const, name: 'c++(fast)' }]
    expect(matchAssetMention('used c++(fast) here', cpp)).toEqual(cpp[0])
    expect(matchAssetMention('used cfast here', cpp)).toBeNull()
  })
  it('right boundary mirrors the left: a path continuation is not a bare-name hit', () => {
    const skillNav = [{ kind: 'skill' as const, name: 'nav' }]
    // The skill `nav` must not claim the reference `nav/limits.md`.
    expect(matchAssetMention('nav/limits.md is stale', skillNav)).toBeNull()
    expect(matchAssetMention('nav/limits.md is stale', [...skillNav, ...names])).toEqual(names[1])
    // `diagnose-x` must not claim `diagnose-x.md`.
    expect(matchAssetMention('diagnose-x.md is stale', names)).toBeNull()
    // A sentence-ending period is still a boundary.
    expect(matchAssetMention('ran diagnose-x.', names)).toEqual(names[0])
  })
  it('left boundary: a partial leading word is null', () => {
    expect(matchAssetMention('xdiagnose-x', names)).toBeNull()
  })
  it('overlapping names: the longest name wins', () => {
    const overlap = [
      { kind: 'skill' as const, name: 'diagnose-x' },
      { kind: 'skill' as const, name: 'diagnose-x-pro' }
    ]
    expect(matchAssetMention('diagnose-x-pro ran', overlap)).toEqual(overlap[1])
  })
})
