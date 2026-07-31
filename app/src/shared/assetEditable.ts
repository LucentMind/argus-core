import type { AuthoringKind } from './authoringIpc'

/**
 * May the editor let the user type into this asset?
 *
 * This is an **affordance, not a security boundary** — the main-process writers are the real
 * enforcement, and both of them re-read the file's own tier off disk before writing. This
 * predicate exists so the window can offer *Edit a copy* instead of letting the user type into
 * a buffer that will be refused, or (for skills) refused with a flatly wrong message.
 *
 * The two kinds have **different rules**, and neither is the Library's `PUSHABLE_TIERS`
 * grouping:
 *
 * - `reference` mirrors `refSync/service.ts:180`, which refuses exactly hive-managed and
 *   bundled files. An untagged reference (`tier === null`) is hand-authored and editable —
 *   `service.ts:197` stamps it `trust_tier: user` on save. Reusing `PUSHABLE_TIERS` here would
 *   make every untagged reference read-only, which is a regression, not a rail.
 * - `skill` mirrors the inverse of `forkSkill`'s guard (`skillsResolver.ts:285`): a skill is
 *   yours iff its tier is `user`. Skills never carry `team-knowledge` — skill tier is derived
 *   from the directory.
 */
export type TierLookup = string | null | undefined

/** Reference tiers whose files `refSync/service.ts` refuses to write. */
const REFERENCE_LOCKED: readonly string[] = ['hivemind', 'confluence', 'bundled']

export function isAssetEditable(kind: AuthoringKind, tier: TierLookup): boolean {
  // Not resolved. Fails OPEN on purpose: the writers still guard the file, and locking someone
  // out of their own asset because a list was slow is worse than letting the write be refused.
  if (tier === undefined) return true
  if (kind === 'skill') return tier === 'user'
  return !REFERENCE_LOCKED.includes(tier ?? '')
}
