import { describe, it, expect } from 'vitest'
import {
  ATTRIBUTION_CONTRACT,
  buildAttributionPrompt,
  parseAttribution,
  pruneAttributionCites,
  completeVerdicts
} from '../attribution'
import { DistillParseError } from '../../contract'
import type { CaseDistillInput } from '../../../../../shared/distill'
import type { Dossier } from '../../../../../shared/distillV3'
import type { AssetInventoryEntry } from '../../../../../shared/attribution'

const INV: AssetInventoryEntry[] = [
  {
    kind: 'skill',
    name: 'diag',
    tier: 'user',
    callCount: 2,
    firstSeen: { sessionId: 1, turnId: 3 }
  },
  {
    kind: 'reference',
    name: 'nav/limits.md',
    tier: null,
    callCount: 1,
    firstSeen: { sessionId: 1, turnId: null }
  }
]
const INPUT: CaseDistillInput = {
  caseMeta: {
    slug: 'c1',
    title: 'T',
    jiraKey: 'NAV-1',
    status: 'closed',
    resolution: 'solved',
    tags: [],
    createdAt: 'a',
    closedAt: 'b'
  },
  findings: [{ id: 7, summary: 'f', reviewState: 'accepted', role: 'root-cause', body: '' }],
  evidence: [],
  sessionTitles: [],
  skillsIndex: [],
  referencesIndex: [],
  rcaStructure: null,
  alreadyCaptured: { proposals: [] },
  world: {
    sessions: [
      {
        id: 1,
        title: 's',
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: 'y' }
        ]
      }
    ]
  } as never,
  assets: INV,
  caseOutcome: 'solved',
  caseDomain: 'NAV'
}
const DOSSIER: Dossier = {
  scope: { status: 'closed', resolution: 'solved', settled: true, note: '' },
  root_cause: { text: 'rc', cites: [{ finding: 7 }] },
  confirmed_fix: null,
  rejected_hypotheses: [],
  diagnostic_path: [],
  durable_facts: [],
  user_corrections: []
}
const fence = (o: unknown): string => '```json\n' + JSON.stringify(o) + '\n```'
const good = {
  kind: 'skill',
  name: 'diag',
  applied: true,
  verdict: 'helped',
  reason: 'followed step 2',
  cites: [{ session: 1, turn: 1 }]
}

describe('buildAttributionPrompt', () => {
  it('carries the contract, the outcome/domain, every asset by kind, and the dossier', () => {
    const p = buildAttributionPrompt(INPUT, DOSSIER)
    expect(p.startsWith(ATTRIBUTION_CONTRACT)).toBe(true)
    expect(p).toContain('outcome: solved')
    expect(p).toContain('domain: NAV')
    expect(p).toContain('skill diag')
    expect(p).toContain('reference nav/limits.md')
    expect(p).toContain('"root_cause"')
  })
  it('describes a reference by its summary: inventory relPath "limits.md" ↔ index name "limits" (A1)', () => {
    const input: CaseDistillInput = {
      ...INPUT,
      assets: [
        { ...INV[1], name: 'nav/limits.md' },
        { ...INV[1], name: 'limits.md' }
      ],
      referencesIndex: [
        { name: 'limits', summary: 'Top-level speed limit table.', content: '', tier: null }
      ]
    }
    const p = buildAttributionPrompt(input, DOSSIER)
    expect(p).toContain(
      '- reference limits.md · used 1× · first seen session 1\n  Top-level speed limit table.'
    )
    // The flat index has no entry for a nested reference; a same-basename top-level file is a
    // DIFFERENT document, so its summary must not be attached to nav/limits.md.
    expect(p).toContain(
      '- reference nav/limits.md · used 1× · first seen session 1\n- reference limits.md'
    )
  })
  it('names every output key in the contract (prose-schema lesson #205)', () => {
    for (const k of ['"kind"', '"name"', '"applied"', '"verdict"', '"reason"', '"cites"'])
      expect(ATTRIBUTION_CONTRACT).toContain(k)
    expect(ATTRIBUTION_CONTRACT).toMatch(/outcome.*(not|never).*(change|override)/i)
  })
  it('resolve() overrides the contract and sections', () => {
    const p = buildAttributionPrompt(INPUT, DOSSIER, (id) => `<<${id}>>`)
    expect(p).toContain('<<headless.case-distill.attribution.contract>>')
    expect(p).toContain('<<headless.case-distill.attribution.section.assets>>')
  })
})

describe('parseAttribution', () => {
  it('parses a good verdict', () => {
    const out = parseAttribution(fence({ verdicts: [good] }), INV)
    expect(out.verdicts).toEqual([good])
    expect(out).toMatchObject({
      malformedDropped: {},
      unknownAssetDropped: {},
      uncitedDropped: 0,
      duplicateDropped: 0
    })
  })
  it('applied:false needs no cites and must have verdict null; a verdict on an unapplied asset is malformed', () => {
    const out = parseAttribution(
      fence({
        verdicts: [
          {
            kind: 'reference',
            name: 'nav/limits.md',
            applied: false,
            verdict: null,
            reason: 'never opened',
            cites: []
          }
        ]
      }),
      INV
    )
    expect(out.verdicts[0]).toMatchObject({ applied: false, verdict: null })
    const bad = parseAttribution(
      fence({
        verdicts: [
          {
            kind: 'reference',
            name: 'nav/limits.md',
            applied: false,
            verdict: 'helped',
            reason: 'x',
            cites: []
          }
        ]
      }),
      INV
    )
    expect(bad.verdicts).toEqual([])
    expect(bad.malformedDropped).toEqual({ verdict: 1 })
  })
  it('a renamed or missing key inside an item is counted, never read as empty', () => {
    const out = parseAttribution(
      fence({
        verdicts: [
          {
            kind: 'skill',
            name: 'diag',
            applied: true,
            judgement: 'helped',
            reason: 'x',
            cites: [{ finding: 7 }]
          }
        ]
      }),
      INV
    )
    expect(out.verdicts).toEqual([])
    expect(out.malformedDropped).toEqual({ verdict: 1 })
    const noReason = parseAttribution(fence({ verdicts: [{ ...good, reason: '' }] }), INV)
    expect(noReason.malformedDropped).toEqual({ reason: 1 })
  })
  it('an asset not in the inventory is dropped and counted by name', () => {
    const out = parseAttribution(fence({ verdicts: [{ ...good, name: 'invented' }] }), INV)
    expect(out.verdicts).toEqual([])
    expect(out.unknownAssetDropped).toEqual({ 'skill/invented': 1 })
  })
  it('applied:true with no cites is uncited; duplicates keep the first', () => {
    const out = parseAttribution(
      fence({ verdicts: [{ ...good, cites: [] }, good, { ...good, verdict: 'misled' }] }),
      INV
    )
    expect(out.uncitedDropped).toBe(1)
    expect(out.duplicateDropped).toBe(1)
    expect(out.verdicts).toEqual([good])
  })
  it('an outcome key is ignored; any other top-level key throws', () => {
    expect(
      parseAttribution(fence({ verdicts: [good], outcome: 'rejected' }), INV).verdicts
    ).toEqual([good])
    expect(() => parseAttribution(fence({ verdicts: [good], extra: 1 }), INV)).toThrow(
      DistillParseError
    )
    expect(() => parseAttribution('no fence', INV)).toThrow(DistillParseError)
  })
  it('reason is clamped to 240 chars', () => {
    const out = parseAttribution(fence({ verdicts: [{ ...good, reason: 'x'.repeat(500) }] }), INV)
    expect(out.verdicts[0].reason).toHaveLength(240)
  })
})

describe('pruneAttributionCites + completeVerdicts', () => {
  it('drops cites the input cannot verify; an applied verdict left citeless becomes uncited', () => {
    const out = parseAttribution(
      fence({
        verdicts: [
          {
            ...good,
            cites: [
              { session: 1, turn: 1 },
              { session: 9, turn: 0 }
            ]
          },
          {
            kind: 'reference',
            name: 'nav/limits.md',
            applied: true,
            verdict: 'neutral',
            reason: 'r',
            cites: [{ finding: 999 }]
          }
        ]
      }),
      INV
    )
    const pruned = pruneAttributionCites(out, INPUT)
    expect(pruned.verdicts).toEqual([{ ...good, cites: [{ session: 1, turn: 1 }] }])
    expect(pruned.uncitedDropped).toBe(1)
  })
  it('adds a silent row for every inventoried asset the judge did not mention', () => {
    const out = completeVerdicts(parseAttribution(fence({ verdicts: [good] }), INV), INV)
    expect(out.verdicts).toEqual([
      good,
      {
        kind: 'reference',
        name: 'nav/limits.md',
        applied: null,
        verdict: null,
        reason: '',
        cites: []
      }
    ])
  })
})
