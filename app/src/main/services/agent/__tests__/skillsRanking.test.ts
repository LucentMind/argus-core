import { describe, it, expect } from 'vitest'
import { rankSkillsForMode, type ResolvedSkill } from '../skillsResolver'

function skill(name: string, roles: string[]): ResolvedSkill {
  return {
    name,
    tier: 'user',
    dir: `/x/${name}`,
    description: '',
    enabled: true,
    shadows: [],
    roles
  }
}

describe('rankSkillsForMode', () => {
  it('puts role-matched and universal skills first, non-matching last, stably', () => {
    const skills = [
      skill('a-triage', ['triage']),
      skill('b-universal', []),
      skill('c-review', ['review']),
      skill('d-both', ['review', 'triage'])
    ]
    const ranked = rankSkillsForMode(skills, 'review').map((s) => s.name)
    // matched/universal first in input order: b-universal, c-review, d-both; then a-triage
    expect(ranked).toEqual(['b-universal', 'c-review', 'd-both', 'a-triage'])
  })

  it("is a no-op ordering when every skill is universal (today's skills)", () => {
    const skills = [skill('one', []), skill('two', []), skill('three', [])]
    expect(rankSkillsForMode(skills, 'triage').map((s) => s.name)).toEqual(['one', 'two', 'three'])
  })
})
