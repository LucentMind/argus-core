// app/src/main/services/agent/__tests__/modeAssembly.test.ts
import { describe, it, expect } from 'vitest'
import { assembleMode } from '../modeAssembly'
import type { ResolvedSkill } from '../skillsResolver'
import { CONTRIBUTE_BACK_NUDGE, DIAGRAM_FRAGMENT, NEUTRAL_PERSONA, TRIAGE_FRAGMENT } from '../persona'
import { MODES } from '../../../../shared/modes'

function skill(name: string, roles: string[], enabled = true): ResolvedSkill {
  return { name, tier: 'user', dir: `/x/${name}`, description: '', enabled, shadows: [], roles }
}

describe('assembleMode', () => {
  it('investigation: mode identity + neutral core + packs, alphabetical skill order preserved', () => {
    const out = assembleMode({
      mode: 'investigation',
      resolvedSkills: [skill('a', []), skill('b', []), skill('c', [], false)],
      packFragments: ['PACK'],
      contributeBack: false
    })
    expect(out.personaFragments).toEqual([TRIAGE_FRAGMENT, NEUTRAL_PERSONA, DIAGRAM_FRAGMENT, 'PACK'])
    expect(out.enabledSkills).toEqual(['a', 'b'])
  })

  it('review: appends the review persona fragment and ranks review skills first', () => {
    const out = assembleMode({
      mode: 'review',
      resolvedSkills: [skill('triage-only', ['triage']), skill('review-only', ['review'])],
      packFragments: [],
      contributeBack: true
    })
    expect(out.personaFragments).toEqual([
      MODES.review.personaFragment,
      NEUTRAL_PERSONA,
      DIAGRAM_FRAGMENT,
      CONTRIBUTE_BACK_NUDGE
    ])
    expect(out.enabledSkills).toEqual(['review-only', 'triage-only'])
  })
})
