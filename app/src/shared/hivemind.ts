export type HivemindState = 'dormant' | 'not-cloned' | 'ready' | 'error'
export interface HivemindItem {
  kind: 'skill' | 'reference'
  name: string
  description: string
  /** `Name <email>` read from the clone, so Browse can name a contributor before you install. */
  author: string | null
  commit: string
  installed: boolean
  installedCommit: string | null
  /** trust_tier of the locally installed copy (references only; null for skills / not installed). */
  localTier: string | null
  /** A skills-user copy of this skill exists and shadows the installed one (skills only). */
  shadowedByUser: boolean
  updateAvailable: boolean
}
/** Whether the installed local reference has edits that are in neither the pin nor HEAD. */
export interface LocalDivergence {
  diverged: boolean
  /** Unified diff, local → incoming. Empty when not diverged, and also empty in the
   *  fail-closed case (diverged: true but the other side couldn't be read to compare). */
  diff: string
  /**
   * Set when installing would restamp the file's trust_tier — independent of `diverged`,
   * because a confluence/ twin with byte-identical content still costs push rights.
   */
  tierChange: { from: string; to: string } | null
}
export interface PushableItem {
  kind: 'skill' | 'reference'
  name: string
}
/** One successful HiveMind push (Tier 2.3) — last push wins; absent key = never pushed. */
export interface PushReceipt {
  prUrl: string
  pushedAt: string
}
/**
 * Whether an open HiveMind share PR already exists for one asset, and whether it is ours.
 *
 * `none` also covers every "could not tell" case (no repo, no clone, gh unreachable): the share
 * flow then behaves exactly as it did before this check existed. `warning` is set only when a
 * check was attempted and failed, so the dialog can say the duplicate check did not run.
 */
export type PushStatus =
  | { state: 'none'; warning?: string }
  | { state: 'open-mine'; prUrl: string; changed: boolean }
  | { state: 'open-teammate'; prUrl: string; prAuthor: string }
export interface HivemindPayload {
  repo: string
  state: HivemindState
  error: string | null
  headCommit: string | null
  lastSynced: string | null
  items: HivemindItem[]
  pushable: PushableItem[]
  /** Push receipts keyed 'skill/<name>' | 'reference/<name>'. */
  pushes: Record<string, PushReceipt>
}
/**
 * `created` — a brand-new PR was opened. `updated` — a real commit landed on an existing PR's
 * branch. `unchanged` — nothing was pushed at all: either `pushStatus` already found the open
 * PR unchanged, or the worktree's own porcelain check found nothing staged after re-deriving.
 * Both no-op paths in `push()` must resolve here, not to `created` — a boolean `updated: false`
 * used to conflate "just created" with "nothing happened," so the renderer showed "PR opened"
 * for a push that touched nothing.
 */
export type HivemindPushOutcome = 'created' | 'updated' | 'unchanged'
export type HivemindPushResult =
  | { ok: true; prUrl: string; outcome: HivemindPushOutcome }
  | { ok: false; error: string; blockedByPrUrl?: string; blockedByAuthor?: string }
export type HivemindCheckResult = { ok: true } | { ok: false; error: string }
