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
