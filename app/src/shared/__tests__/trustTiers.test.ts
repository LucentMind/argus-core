import { describe, expect, it } from 'vitest'
import {
  TRUST_TIERS,
  PUSHABLE_TIERS,
  HIVE_MANAGED_TIERS,
  NON_PACK_TIERS,
  TIER_LABELS,
  TIER_EXPLANATIONS
} from '../trustTiers'

describe('trustTiers', () => {
  it('every derived set is a subset of the ladder', () => {
    for (const t of [...PUSHABLE_TIERS, ...HIVE_MANAGED_TIERS, ...NON_PACK_TIERS]) {
      expect(TRUST_TIERS).toContain(t)
    }
  })

  it('pushable and hive-managed are disjoint', () => {
    for (const t of PUSHABLE_TIERS) expect(HIVE_MANAGED_TIERS).not.toContain(t)
  })

  it('every tier has a label and an explanation', () => {
    for (const t of TRUST_TIERS) {
      expect(TIER_LABELS[t]).toBeTruthy()
      expect(TIER_EXPLANATIONS[t]).toBeTruthy()
    }
  })
})
