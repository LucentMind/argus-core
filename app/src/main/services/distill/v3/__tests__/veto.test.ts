import { describe, it, expect } from 'vitest'
import { vetoCandidates } from '../veto'
import type { Dossier, KnowledgeCandidate } from '../../../../../shared/distillV3'
import type { CaseDistillInput } from '../../../../../shared/distill'

const D: Dossier = {
  scope: { status: 'closed', resolution: 'solved', settled: true, note: '' },
  root_cause: { text: 'rc', cites: [{ finding: 7 }] },
  confirmed_fix: null,
  rejected_hypotheses: [],
  diagnostic_path: [],
  durable_facts: [],
  user_corrections: []
}
const INPUT = {
  caseMeta: { status: 'closed', resolution: 'solved' },
  skillsIndex: [{ name: 'diagnose-x', description: '', content: '' }],
  referencesIndex: [
    { name: 'conf-ref', summary: '', content: '', tier: 'confluence' },
    { name: 'team-ref', summary: '', content: '', tier: null }
  ],
  alreadyCaptured: {
    proposals: [{ type: 'reference-edit', target: 'team-ref', title: '', state: 'accepted' }]
  }
} as unknown as CaseDistillInput
const base = (over: Partial<KnowledgeCandidate>): KnowledgeCandidate => ({
  kind: 'procedure',
  type: 'skill-new',
  target: 'diagnose-new',
  title: 't',
  outline: 'o',
  evidence: ['root_cause'],
  related: [],
  generalization: 'g',
  routing_rationale: 'r',
  confidence: 0.9,
  ...over
})

describe('vetoCandidates', () => {
  const reasonOf = (c: KnowledgeCandidate): string | undefined =>
    vetoCandidates([c], D, INPUT).dropped[0]?.reason
  it('keeps a valid skill-new', () =>
    expect(vetoCandidates([base({})], D, INPUT).kept).toHaveLength(1))
  it('malformed: unresolvable evidence', () =>
    expect(reasonOf(base({ evidence: ['durable_facts[3]'] }))).toBe('malformed'))
  it('unknown-target: skill-edit not in index', () =>
    expect(reasonOf(base({ type: 'skill-edit', target: 'nope' }))).toBe('unknown-target'))
  it('target-exists: skill-new already installed', () =>
    expect(reasonOf(base({ target: 'diagnose-x' }))).toBe('target-exists'))
  it('confluence-tier', () =>
    expect(reasonOf(base({ kind: 'fact', type: 'reference-edit', target: 'conf-ref' }))).toBe(
      'confluence-tier'
    ))
  it('bad-name', () => expect(reasonOf(base({ target: 'has space' }))).toBe('bad-name'))
  it('duplicate vs already-captured', () =>
    expect(reasonOf(base({ kind: 'fact', type: 'reference-edit', target: 'team-ref' }))).toBe(
      'duplicate'
    ))
  it('kind-type-mismatch both ways', () => {
    expect(reasonOf(base({ kind: 'fact' }))).toBe('kind-type-mismatch')
    expect(reasonOf(base({ kind: 'procedure', type: 'reference-edit', target: 'new-ref' }))).toBe(
      'kind-type-mismatch'
    )
  })
  it('cap by resolution, ordered by confidence, dedupes intra-batch first', () => {
    const cs = [
      base({ target: 'a', confidence: 0.3 }),
      base({ target: 'b', confidence: 0.9 }),
      base({ target: 'b', confidence: 0.8 }),
      base({ target: 'c', confidence: 0.7 }),
      base({ target: 'd', confidence: 0.6 })
    ]
    const r = vetoCandidates(cs, D, INPUT)
    expect(r.kept.map((k) => k.target)).toEqual(['b', 'c', 'd'])
    expect(r.dropped.map((d) => `${d.target}:${d.reason}`).sort()).toEqual(['a:cap', 'b:duplicate'])
  })
  it('open case cap is 2', () => {
    const open = {
      ...INPUT,
      caseMeta: { status: 'open', resolution: null }
    } as unknown as CaseDistillInput
    const r = vetoCandidates(
      [base({ target: 'a' }), base({ target: 'b' }), base({ target: 'c' })],
      D,
      open
    )
    expect(r.kept).toHaveLength(2)
  })
})
