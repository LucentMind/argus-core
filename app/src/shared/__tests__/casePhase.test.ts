import { describe, it, expect } from 'vitest'
import { derivePhase, type PhaseSignals } from '../casePhase'

const NONE: PhaseSignals = {
  status: 'open',
  lastEvidenceAt: null,
  lastInvestigationAt: null,
  lastInvestigationFindingAt: null,
  prLinkedAt: null,
  lastReviewAt: null,
  lastReviewFindingAt: null,
  phasePin: null,
  phasePinnedAt: null
}

const T = (n: number): string => `2026-08-01T10:0${n}:00.000Z`

describe('derivePhase', () => {
  it('is open when nothing has happened', () => {
    expect(derivePhase(NONE)).toBe('open')
  })

  it('maps each signal to its phase when it stands alone', () => {
    expect(derivePhase({ ...NONE, lastEvidenceAt: T(1) })).toBe('analyzing')
    expect(derivePhase({ ...NONE, lastInvestigationAt: T(1) })).toBe('analyzing')
    expect(derivePhase({ ...NONE, lastInvestigationFindingAt: T(1) })).toBe('analyzing')
    expect(derivePhase({ ...NONE, prLinkedAt: T(1) })).toBe('pr-created')
    expect(derivePhase({ ...NONE, lastReviewAt: T(1) })).toBe('reviewing')
    expect(derivePhase({ ...NONE, lastReviewFindingAt: T(1) })).toBe('reviewing')
    expect(derivePhase({ ...NONE, phasePin: 'rca-drafted', phasePinnedAt: T(1) })).toBe(
      'rca-drafted'
    )
  })

  it('returns the phase of the NEWEST signal, not the furthest-along one', () => {
    // The reported defect: PR linked, review run, then back to investigation.
    expect(
      derivePhase({
        ...NONE,
        prLinkedAt: T(1),
        lastReviewAt: T(2),
        lastInvestigationAt: T(3)
      })
    ).toBe('analyzing')
  })

  it('advances forward just as readily', () => {
    expect(
      derivePhase({ ...NONE, lastInvestigationAt: T(1), prLinkedAt: T(2), lastReviewAt: T(3) })
    ).toBe('reviewing')
    expect(derivePhase({ ...NONE, lastInvestigationAt: T(1), prLinkedAt: T(2) })).toBe('pr-created')
  })

  it('lets a pin win when it is newest and lose when it is not', () => {
    expect(
      derivePhase({ ...NONE, lastReviewAt: T(1), phasePin: 'rca-drafted', phasePinnedAt: T(2) })
    ).toBe('rca-drafted')
    expect(
      derivePhase({
        ...NONE,
        phasePin: 'rca-drafted',
        phasePinnedAt: T(1),
        lastInvestigationAt: T(2)
      })
    ).toBe('analyzing')
  })

  it('ignores a pinned-at with no pin, and a pin with no pinned-at', () => {
    expect(derivePhase({ ...NONE, phasePinnedAt: T(9) })).toBe('open')
    expect(derivePhase({ ...NONE, phasePin: 'rca-drafted' })).toBe('open')
  })

  it('closed overrides every signal', () => {
    expect(
      derivePhase({
        ...NONE,
        status: 'closed',
        lastInvestigationAt: T(9),
        phasePin: 'rca-drafted',
        phasePinnedAt: T(9)
      })
    ).toBe('closed')
  })

  it('breaks an exact timestamp tie deterministically, most specific first', () => {
    const same = T(5)
    expect(derivePhase({ ...NONE, lastInvestigationAt: same, lastReviewAt: same })).toBe('reviewing')
    expect(derivePhase({ ...NONE, lastInvestigationAt: same, prLinkedAt: same })).toBe('pr-created')
    expect(
      derivePhase({ ...NONE, lastReviewAt: same, phasePin: 'rca-drafted', phasePinnedAt: same })
    ).toBe('rca-drafted')
  })
})
