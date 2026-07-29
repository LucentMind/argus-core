import { describe, it, expect } from 'vitest'
import { MODES, DEFAULT_MODE, availableModes, type ModeId } from '../modes'

describe('mode registry', () => {
  it('defaults to investigation', () => {
    expect(DEFAULT_MODE).toBe('investigation')
  })

  it('investigation is always available; review needs a linked repo', () => {
    expect(availableModes({ linkedRepoCount: 0 })).toEqual<ModeId[]>(['investigation'])
    expect(availableModes({ linkedRepoCount: 2 })).toEqual<ModeId[]>(['investigation', 'review'])
  })

  it('investigation carries the triage identity fragment (composed first, ahead of the neutral core)', () => {
    expect(MODES.investigation.personaFragment.length).toBeGreaterThan(0)
    expect(MODES.investigation.personaFragment).toContain('defect-analysis agent')
    expect(MODES.investigation.role).toBe('triage')
  })

  it('review carries a non-empty persona fragment and the review role', () => {
    expect(MODES.review.personaFragment.length).toBeGreaterThan(0)
    expect(MODES.review.role).toBe('review')
  })

  it("review's method block mandates find/verify separation and verified labels", () => {
    expect(MODES.review.personaFragment).toContain('Method — how you review')
    expect(MODES.review.personaFragment).toContain('CONFIRMED')
    expect(MODES.review.personaFragment).toContain('PLAUSIBLE')
    expect(MODES.review.personaFragment).toContain('failure scenario')
  })

  it("review's persona cites diff code the same way BASE_PERSONA cites linked-workspace code", () => {
    // A [<path>:<line>] citation (no repo prefix) would not render as a clickable link for
    // code in a linked workspace repo — see persona.ts's BASE_PERSONA citation rule.
    expect(MODES.review.personaFragment).toContain('[<repo-name>/<repo-relative-path>:<line>]')
    expect(MODES.review.personaFragment).not.toMatch(/\[<path>:<line>\]/)
  })

  it("review's citation guidance distinguishes review artifacts from investigation evidence", () => {
    expect(MODES.review.personaFragment).toContain('[artifacts/')
    expect(MODES.review.personaFragment).toContain('evidence/')
  })

  it('MODE_ORDER (via availableModes) covers every key of MODES', () => {
    const allAvailable = availableModes({ linkedRepoCount: Infinity })
    expect(new Set(allAvailable)).toEqual(new Set(Object.keys(MODES)))
  })
})
