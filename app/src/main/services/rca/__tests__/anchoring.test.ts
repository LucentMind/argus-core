import { describe, it, expect } from 'vitest'
import { draftAnchoring } from '../anchoring'
import type { RcaDraft } from '../../../../shared/rca'

const draft = (over: Partial<RcaDraft> = {}): RcaDraft => ({
  rootCause: { findingId: 6, statement: 'root', evidence: [] },
  contributing: [
    { findingId: 4, statement: 'mid', evidence: [] },
    { findingId: null, statement: 'invented', evidence: [] }
  ],
  symptoms: [{ findingId: null, statement: 'seen' }],
  ruledOut: [{ findingId: 5, statement: 'skew', why: 'old build' }],
  duplicates: [{ findingId: 9, ofFindingId: 6 }],
  impact: '',
  timeline: [],
  remediation: { immediate: '', followUps: [] },
  execSummary: { whatBroke: '', impact: '', why: '', nextSteps: '' },
  techNarrative: [],
  sections: {},
  ...over
})
const f = (
  id: number,
  over: Partial<{
    mode: string
    reviewState: string
    role: string | null
    supersededBy: number | null
  }> = {}
): Parameters<typeof draftAnchoring>[1][number] => ({
  id,
  mode: 'investigation',
  reviewState: 'pending',
  role: null,
  supersededBy: null,
  ...over
})

describe('draftAnchoring', () => {
  it('counts statements without a finding per section', () => {
    expect(draftAnchoring(draft(), []).unanchored).toEqual({
      rootCause: 0,
      contributing: 1,
      symptoms: 1,
      ruledOut: 0
    })
    expect(
      draftAnchoring(draft({ rootCause: { findingId: null, statement: 'x', evidence: [] } }), [])
        .unanchored.rootCause
    ).toBe(1)
  })
  it('lists active investigation findings the draft never names, ascending', () => {
    const findings = [
      f(6, { role: 'root-cause' }),
      f(4),
      f(2, { role: 'symptom' }), // active, unnamed → unused
      f(9), // named as a duplicate
      f(5, { role: 'ruled-out' }), // inactive → never unused
      f(3, { supersededBy: 6 }), // inactive
      f(8, { reviewState: 'rejected' }), // inactive
      f(11, { mode: 'review' }), // not the chain
      f(1) // active, unnamed → unused
    ]
    expect(draftAnchoring(draft(), findings).unused).toEqual([1, 2])
  })
})
