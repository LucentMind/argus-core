import { describe, it, expect } from 'vitest'
import { isAssetEditable } from '../assetEditable'
import { TRUST_TIERS } from '../trustTiers'

/**
 * A table over every tier the app knows, for both kinds, because the two rules differ and the
 * difference is the whole point. Each expectation names the main-process guard it mirrors — if
 * one of those guards moves, this table is where the drift shows up.
 */
describe('isAssetEditable', () => {
  describe('skills — editable iff tier is `user` (mirrors forkSkill, skillsResolver.ts:285)', () => {
    it('allows a user skill', () => {
      expect(isAssetEditable('skill', 'user')).toBe(true)
    })

    it('refuses a bundled skill', () => {
      expect(isAssetEditable('skill', 'bundled')).toBe(false)
    })

    it('refuses a hivemind skill', () => {
      expect(isAssetEditable('skill', 'hivemind')).toBe(false)
    })

    // Not reachable today (skill tier comes from the directory, so it is only ever one of the
    // three above) but the signature admits it, and `team-knowledge` is the tier PUSHABLE_TIERS
    // would have let through. Pinned so nobody widens the rule to match the Library's grouping.
    it('refuses a team-knowledge skill', () => {
      expect(isAssetEditable('skill', 'team-knowledge')).toBe(false)
    })
  })

  describe('references — refuses only hive-managed and bundled (mirrors refSync/service.ts:180)', () => {
    it('refuses a hivemind reference', () => {
      expect(isAssetEditable('reference', 'hivemind')).toBe(false)
    })

    it('refuses a confluence reference', () => {
      expect(isAssetEditable('reference', 'confluence')).toBe(false)
    })

    it('refuses a bundled reference', () => {
      expect(isAssetEditable('reference', 'bundled')).toBe(false)
    })

    it('allows a user reference', () => {
      expect(isAssetEditable('reference', 'user')).toBe(true)
    })

    it('allows a team-knowledge reference', () => {
      expect(isAssetEditable('reference', 'team-knowledge')).toBe(true)
    })

    // The regression this predicate exists to avoid. An untagged reference is hand-authored:
    // refSync/service.ts:197 stamps it `trust_tier: user` on save rather than refusing it.
    // The Library groups `null` under "Built-in", and following that grouping here would make
    // every untagged reference read-only.
    it('allows an untagged reference', () => {
      expect(isAssetEditable('reference', null)).toBe(true)
    })
  })

  describe('unknown tier fails open (deviation 2)', () => {
    it('allows a skill whose tier has not resolved yet', () => {
      expect(isAssetEditable('skill', undefined)).toBe(true)
    })

    it('allows a reference whose tier has not resolved yet', () => {
      expect(isAssetEditable('reference', undefined)).toBe(true)
    })
  })

  it('answers for every tier the app defines, for both kinds', () => {
    for (const tier of TRUST_TIERS) {
      expect(typeof isAssetEditable('skill', tier)).toBe('boolean')
      expect(typeof isAssetEditable('reference', tier)).toBe('boolean')
    }
  })
})
