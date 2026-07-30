import { describe, it, expect } from 'vitest'
import { buildSkillIndex } from '../skillIndex'
import { assembleMode } from '../modeAssembly'
import type { ResolvedSkill } from '../skillsResolver'

function skill(name: string, roles: string[], description = `does ${name}`): ResolvedSkill {
  return {
    name,
    tier: 'user',
    dir: `/x/${name}`,
    description,
    author: null,
    enabled: true,
    shadows: [],
    roles
  }
}

describe('buildSkillIndex', () => {
  it('lists universal and role-matched skills, omitting non-matching ones', () => {
    const out = buildSkillIndex(
      [skill('universal', []), skill('rev', ['review']), skill('tri', ['triage'])],
      'review'
    )
    expect(out).toContain('universal')
    expect(out).toContain('rev')
    expect(out).not.toContain('tri')
  })

  it('includes each listed skill description', () => {
    expect(buildSkillIndex([skill('alpha', [], 'finds alphas')], 'triage')).toContain(
      'finds alphas'
    )
  })

  it('returns empty string when nothing qualifies', () => {
    expect(buildSkillIndex([skill('rev', ['review'])], 'triage')).toBe('')
  })

  it('omits the trailing colon for a skill with an empty description', () => {
    const out = buildSkillIndex([skill('bare', [], '')], 'triage')
    expect(out).toBe('Skills most relevant to this mode:\n- bare')
  })

  it('truncates a long description to ~200 chars with an ellipsis', () => {
    const long = 'x'.repeat(280)
    const out = buildSkillIndex([skill('long', [], long)], 'triage')
    const line = out.split('\n').find((l) => l.startsWith('- long:'))!
    expect(line).toBe(`- long: ${'x'.repeat(200)}…`)
    expect(line.length).toBeLessThan(long.length)
  })
})

describe('assembleMode + index', () => {
  it('indexes only mode-relevant skills but keeps ALL enabled skills in the allowlist', () => {
    const out = assembleMode({
      mode: 'review',
      resolvedSkills: [skill('tri', ['triage']), skill('rev', ['review'])],
      packFragments: [],
      contributeBack: false
    })
    // anti-silo: availability is never partitioned
    expect(out.enabledSkills.sort()).toEqual(['rev', 'tri'])
    // advertising IS mode-scoped
    expect(out.skillIndex).toContain('rev')
    expect(out.skillIndex).not.toContain('tri')
  })
})
