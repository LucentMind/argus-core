/**
 * The provenance ladder for shared knowledge assets (skills + references).
 * Single source of truth — hivemind.ts (push eligibility), proposals.ts
 * (accept stamping), and skillsDir.ts (pack re-seed protection) all derive
 * from these sets instead of re-declaring them.
 */
export const TRUST_TIERS = ['bundled', 'confluence', 'hivemind', 'team-knowledge', 'user'] as const
export type TrustTier = (typeof TRUST_TIERS)[number]

/** Tiers whose local copy the user authored/curated — eligible for HiveMind push. */
export const PUSHABLE_TIERS: readonly TrustTier[] = ['user', 'team-knowledge']

/** Tiers owned by an external source (hive pin / refsync) — uninstallable, never pushable. */
export const HIVE_MANAGED_TIERS: readonly TrustTier[] = ['hivemind', 'confluence']

/** Tiers a pack re-seed must never clobber (written after seeding: synced/authored). */
export const NON_PACK_TIERS: readonly TrustTier[] = [
  'confluence',
  'user',
  'team-knowledge',
  'hivemind'
]

export const TIER_LABELS: Record<TrustTier, string> = {
  bundled: 'bundled',
  confluence: 'confluence',
  hivemind: 'hivemind',
  'team-knowledge': 'team knowledge',
  user: 'user'
}

export const TIER_EXPLANATIONS: Record<TrustTier, string> = {
  bundled: 'Shipped by a pack.',
  confluence: 'Synced from Confluence. Owned by reference sync.',
  hivemind: "Installed from your team's HiveMind, pinned to a commit. Claim it to make it yours.",
  'team-knowledge': 'Accepted from an agent proposal. Can be shared to the HiveMind.',
  user: 'Authored or accepted by you. Can be shared to the HiveMind.'
}
