import { describe, it, expect } from 'vitest'
import { assembleMode } from '../../agent/modeAssembly'
import { buildSkillIndex } from '../../agent/skillIndex'
import type { ResolvedSkill } from '../../agent/skillsResolver'
import { NEUTRAL_PERSONA, DIAGRAM_FRAGMENT } from '../../agent/persona'
import { MODES } from '../../../../shared/modes'

function skill(name: string, roles: string[] = [], enabled = true): ResolvedSkill {
  return {
    name,
    tier: 'user',
    dir: `/x/${name}`,
    description: 'd',
    author: null,
    enabled,
    shadows: [],
    roles
  }
}

/** Marks each id so a swap is unmistakable, and proves the id we expect is the id requested. */
const stub = (id: string): string => `<<${id}>>`

describe('persona path honours an injected resolver', () => {
  it('assembleMode resolves mode identity, neutral core and diagram guidance by id', () => {
    const out = assembleMode({
      mode: 'investigation',
      resolvedSkills: [],
      packFragments: [],
      contributeBack: false,
      resolve: stub
    })
    expect(out.personaFragments).toEqual([
      '<<persona.mode.investigation>>',
      '<<persona.neutral>>',
      '<<persona.diagram>>'
    ])
  })

  it('assembleMode resolves the review identity in review mode', () => {
    const out = assembleMode({
      mode: 'review',
      resolvedSkills: [],
      packFragments: [],
      contributeBack: false,
      resolve: stub
    })
    expect(out.personaFragments[0]).toBe('<<persona.mode.review>>')
  })

  it('assembleMode resolves the contribute-back nudge only when enabled', () => {
    const withNudge = assembleMode({
      mode: 'investigation',
      resolvedSkills: [],
      packFragments: [],
      contributeBack: true,
      resolve: stub
    })
    expect(withNudge.personaFragments).toContain('<<persona.contribute-back>>')
  })

  it('assembleMode keeps pack fragments verbatim and after the diagram fragment', () => {
    const out = assembleMode({
      mode: 'investigation',
      resolvedSkills: [],
      packFragments: ['PACK'],
      contributeBack: true,
      resolve: stub
    })
    expect(out.personaFragments).toEqual([
      '<<persona.mode.investigation>>',
      '<<persona.neutral>>',
      '<<persona.diagram>>',
      'PACK',
      '<<persona.contribute-back>>'
    ])
  })

  it('assembleMode with no resolver is unchanged — the constants still win', () => {
    const out = assembleMode({
      mode: 'investigation',
      resolvedSkills: [],
      packFragments: [],
      contributeBack: false
    })
    expect(out.personaFragments).toEqual([
      MODES.investigation.personaFragment,
      NEUTRAL_PERSONA,
      DIAGRAM_FRAGMENT
    ])
  })

  it('buildSkillIndex resolves its lead line', () => {
    const out = buildSkillIndex([skill('a')], 'triage', stub)
    expect(out.split('\n')[0]).toBe('<<session.skill-index-lead>>')
    expect(out).toContain('- a: d')
  })

  it('buildSkillIndex with no resolver keeps the default lead line', () => {
    expect(buildSkillIndex([skill('a')], 'triage').split('\n')[0]).toBe(
      'Skills most relevant to this mode:'
    )
  })

  it('buildSkillIndex returns empty for no relevant skills, resolver or not', () => {
    expect(buildSkillIndex([], 'triage', stub)).toBe('')
  })
})
