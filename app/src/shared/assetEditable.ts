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
 * grouping. Every citation below names a SYMBOL, not a line: these comments are the only record
 * of why the predicate is not `PUSHABLE_TIERS`, and line numbers have already drifted twice.
 *
 * - `reference` mirrors `ReferenceSyncService.writeReference` (refSync/service.ts), whose tier
 *   check refuses exactly hive-managed, Confluence-synced and bundled files. An untagged
 *   reference (`tier === null`) is hand-authored and editable — the same method's
 *   `withFrontmatter(content, { trust_tier: tier ?? 'user' })` stamp is what makes it `user` on
 *   save. Reusing `PUSHABLE_TIERS` here would make every untagged reference read-only, which is
 *   a regression, not a rail.
 * - `skill` mirrors the inverse of `forkSkill`'s ownership guard (agent/skillsResolver.ts),
 *   `if (winner.tier === 'user') throw`: a skill is yours iff its tier is `user`. Skills never
 *   carry `team-knowledge` — skill tier is derived from the directory.
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

/**
 * Does this read-only asset have a real *Edit a copy* path, or only an explanation?
 *
 * {@link isAssetEditable} locks three reference tiers, but only ONE of them can be copied out of.
 * The two questions are not the same, and answering the second with the first offers a button
 * whose IPC always rejects:
 *
 * - `skill` — `forkSkill`'s ownership guard (agent/skillsResolver.ts) lets any non-`user` skill be
 *   copied into `skills-user`, so every read-only skill has a way out.
 * - `reference` — `HivemindService.claimReference` (services/hivemind.ts) refuses anything but an
 *   installed HiveMind reference: `if (referenceTier(file) !== 'hivemind') throw`. This mirrors
 *   the gate the Library already applies to its own Claim button (`LibraryPage`'s
 *   `r.tier === 'hivemind'`), and the two must not drift. A `confluence` reference is rebuilt
 *   from its page on every sync and a
 *   `bundled` one ships with a pack — neither has anywhere to be claimed *from*, which is exactly
 *   what their `TIER_EXPLANATIONS` sentence already tells the user.
 *
 * Editable assets answer `false`: there is nothing to copy out of an asset you can just type into.
 */
export function canEditCopy(kind: AuthoringKind, tier: TierLookup): boolean {
  if (isAssetEditable(kind, tier)) return false
  if (kind === 'skill') return true
  return tier === 'hivemind'
}
