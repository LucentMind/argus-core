import { describe, it, expect } from 'vitest'
import { MODES, DEFAULT_MODE, availableModes, type ModeId } from '../modes'

describe('mode registry', () => {
  it('defaults to investigation', () => {
    expect(DEFAULT_MODE).toBe('investigation')
  })

  it('investigation is always available; review needs a linked PR', () => {
    expect(availableModes({ linkedPrCount: 0 })).toEqual<ModeId[]>(['investigation'])
    expect(availableModes({ linkedPrCount: 2 })).toEqual<ModeId[]>(['investigation', 'review'])
  })

  it('investigation carries an empty persona fragment (behavior-identical to today)', () => {
    expect(MODES.investigation.personaFragment).toBe('')
    expect(MODES.investigation.role).toBe('triage')
  })

  it('review carries a non-empty persona fragment and the review role', () => {
    expect(MODES.review.personaFragment.length).toBeGreaterThan(0)
    expect(MODES.review.role).toBe('review')
  })
})
