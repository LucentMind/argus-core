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

/** Tiers a NEW write must never land on — reference writes (accept, manual editor) refuse
 *  these; skills use a separate bundled-only check since they shadow into a different
 *  directory instead of overwriting the tiered file in place. */
export const NOT_HAND_OWNED_TIERS: readonly TrustTier[] = ['bundled', 'hivemind', 'confluence']

/**
 * Badge copy. Each value names WHERE an asset came from; the Library group it sits in
 * already states what may be done with it, so these must not repeat the rights.
 * One word each: `Chip` uppercases in CSS, and a row already carries a kind chip plus
 * usage/stale/receipt chips.
 */
export const TIER_LABELS: Record<TrustTier, string> = {
  bundled: 'pack',
  confluence: 'Confluence',
  hivemind: 'HiveMind',
  'team-knowledge': 'proposed',
  user: 'you'
}

export const TIER_EXPLANATIONS: Record<TrustTier, string> = {
  bundled: 'Ships with an installed pack, or with Argus core. Contribute to the pack, or to Argus itself, to change it.',
  confluence: 'Rebuilt from its Confluence page on every sync — local edits are overwritten.',
  hivemind: "Installed from your team's HiveMind, pinned to a commit.",
  'team-knowledge': 'An agent drafted this; you accepted it. Yours to edit, delete, or share.',
  user: 'You wrote or claimed this. Yours to edit, delete, or share.'
}
