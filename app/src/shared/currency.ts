/**
 * One vocabulary for "what would change, and may it change unattended" — the counterpart to
 * `updates.ts`'s `UpdateStatus`, which describes a single thing's progress. Defined once so the
 * reason an update was held back cannot be worded differently by each surface that shows it.
 *
 * Must not import from `src/main`: `tsconfig.web.json` excludes it, and a shared→main import
 * breaks `typecheck:web`.
 */

/** What a candidate is about. Note `hive-skill` and `hive-reference` share one adapter. */
export type CurrencyDomain = 'core' | 'pack' | 'hive-skill' | 'hive-reference'

/** Who was asked. Anchors and backoff are keyed by this, not by `CurrencyDomain`. */
export type AdapterId = 'core' | 'packs' | 'hive'

/**
 * Why an available update was NOT applied unattended. Every one of these means "a human has to
 * decide", never "something went wrong" — transport failures are not blocked reasons and never
 * reach the user.
 */
export type BlockedReason =
  | { kind: 'local-edits' }
  | { kind: 'tier-change'; from: string; to: string }
  | { kind: 'new-dependency' }
  | { kind: 'downgrade' }
  | { kind: 'origin-pin' }
  | { kind: 'auth' }
  /** The GitHub CLI (gh) is not installed or not on PATH. Distinct from `auth`: the fix is
   *  installing gh, not signing in. Named `gh-missing`, not the domain-agnostic `missing`: this
   *  kind is bound to a GitHub-CLI-specific sentence below, and a bare `missing` would silently
   *  invite a future hive or core producer to reuse it for an unrelated "not found" case and
   *  render "Install the GitHub CLI to continue." for something that has nothing to do with gh. */
  | { kind: 'gh-missing' }
  /** `gh` answered HTTP 404 for the pinned repo. GitHub answers identically for "no such repo"
   *  and "private, no access to this account" — the sentence must not pretend to know which.
   *  Named `gh-notfound` for the same reason as `gh-missing` above. */
  | { kind: 'gh-notfound' }
  /** `gh` answered HTTP 403: the token may need organization (SAML/SSO) authorization, or the
   *  account may be rate-limited. Named `gh-forbidden` for the same reason as `gh-missing` and
   *  `gh-notfound` — it is bound to a GitHub-CLI-specific sentence below. */
  | { kind: 'gh-forbidden' }
  | { kind: 'unsupported' }

export interface Candidate {
  domain: CurrencyDomain
  /** Stable identity: 'core' | <pack id> | 'skill/<name>' | 'reference/<name>'. */
  key: string
  /** Human-facing name for this thing. */
  label: string
  /** null ⇒ not installed: a new hive item the mirror would adopt. */
  from: string | null
  to: string
  verdict: 'clean' | 'blocked'
  reason?: BlockedReason
}

/**
 * The `'skill/<name>' | 'reference/<name>'` half of `Candidate.key`, in the ONE place it is
 * spelled. `main/services/hivemind.ts`'s `declineKey` delegates to this rather than spelling its
 * own copy, so the ledger (declined tombstones), the mirror (`hiveAdapter`, `forgetHooks`) and
 * every renderer surface that filters or labels a hive candidate by key all read the same string
 * (Important 3, whole-branch review). Lives here, not in `main/`, specifically so the renderer —
 * which cannot import from `main/` — has a real import instead of a fourth hand-spelled copy: a
 * near-miss (a different separator, a case change) would otherwise leave every `blockedFor` call
 * returning undefined and every shown-key set failing to match, with no type error and no failing
 * test, because the test fixtures build both sides from the same literal.
 */
export function hiveCandidateKey(kind: 'skill' | 'reference', name: string): string {
  return `${kind}/${name}`
}

export type ApplyOutcome =
  | { ok: true; needsRelaunch?: boolean; needsRestart?: boolean }
  | { ok: false; error: string; reason?: BlockedReason }

/** Everything the Updates surface renders. */
export interface CurrencyPayload {
  auto: boolean
  /** ISO timestamp of the most recent successful survey across all adapters; null if never. */
  lastSurveyAt: string | null
  /** Candidates held back for a decision, from the last survey. Never persisted. */
  blocked: Candidate[]
  /** A survey or an apply batch is in flight. */
  busy: boolean
}

export function blockedOf(candidates: Candidate[]): Candidate[] {
  return candidates.filter((c) => c.verdict === 'blocked')
}

/**
 * The one place a held-back sentence is worded — the counterpart to `updates.ts`'s
 * `describeUpdate`. Every surface that explains a hold renders this and nothing of its own, so
 * the wording cannot drift between the Packs page and the HiveMind page the way status wording
 * has drifted in this codebase before.
 */
export function describeBlocked(reason: BlockedReason): string {
  switch (reason.kind) {
    case 'local-edits':
      return 'You have edited this locally.'
    case 'tier-change':
      // `from` (and, in principle, `to`) can be '' — `referenceTier` returns that for a file with
      // no readable `trust_tier` frontmatter, which `localDivergence` passes straight through.
      // '|| none' matches the wording the pre-existing update-confirm panel already uses for this
      // exact case (`HivemindSettings.tsx`'s `{tierChange.from || 'none'}`) rather than reopening
      // the blank-gap sentence that panel was written to avoid.
      return `This update would change its trust tier from ${reason.from || 'none'} to ${reason.to || 'none'}.`
    case 'new-dependency':
      return 'This update needs a new dependency.'
    case 'auth':
      return 'Sign in to the GitHub CLI to continue.'
    case 'gh-missing':
      return 'Install the GitHub CLI to continue.'
    case 'gh-notfound':
      return "The repository can't be found — check that it still exists and is visible to your account."
    case 'gh-forbidden':
      return 'GitHub refused the request — your token may need organization authorization, or you may be rate-limited.'
    case 'downgrade':
      return 'Installing it would move this install back a version.'
    case 'origin-pin':
      return 'It no longer comes from the origin it was installed from — download it from your vendor and use Install from file.'
    case 'unsupported':
      return 'Updates are only available in a packaged build.'
  }
}

/**
 * Which holds are worth putting in front of someone.
 *
 * `unsupported` is excluded deliberately: it means "this build structurally cannot update"
 * (an unpackaged dev build), which is not a decision anyone can act on. It is unreachable in a
 * packaged build — `supported` is `app.isPackaged` — so excluding it costs nothing in production
 * and stops every dev build from permanently reading "1 item held back". The Version row still
 * shows it, worded by `describeBlocked`, because that row is about the app itself.
 */
export const SURFACED_BLOCK_KINDS: ReadonlySet<BlockedReason['kind']> = new Set([
  'local-edits',
  'tier-change',
  'new-dependency',
  'auth',
  'gh-missing',
  'gh-notfound',
  'gh-forbidden',
  'downgrade',
  'origin-pin'
])

/** Blocked candidates worth surfacing — what every badge and count is derived from. */
export function surfacedBlocked(candidates: Candidate[]): Candidate[] {
  return candidates.filter(
    (c) => c.verdict === 'blocked' && c.reason != null && SURFACED_BLOCK_KINDS.has(c.reason.kind)
  )
}

/**
 * The one sentence for "this section's badge counts more than it can show."
 *
 * Deliberately names no cause. A row can be missing because a filter hides it or because the item
 * is gone since the survey, and the surface knows only that a key matched no row — not which. A
 * sentence that named a cause would be guessing.
 */
export function describeUnshownHolds(n: number): string {
  return `${n} held-back item${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} not shown here.`
}
