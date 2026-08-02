// The whole "where is this case right now" rule, as a pure function of timestamped
// signals. Pure and shared: the main process reads the signals out of SQLite and the
// renderer renders the answer, and neither owns the rule.
//
// MUST NOT import from src/main — tsconfig.web excludes it, and such an import drags
// node:sqlite into the renderer's typecheck. Same constraint as shared/triage.ts.
import type { CasePhase, CasePhasePin, CaseStatus } from './types'

export interface PhaseSignals {
  /** The declared lifecycle. `closed` short-circuits everything below. */
  status: CaseStatus
  /** MAX(evidence.created_at) over non-review-scoped evidence (see shared/evidenceScope.ts),
   *  excluding Jira ticket-mirror rows (origin 'jira' with meta.jira.role set — the
   *  .ticket.md/.ticket.json/.comments.md files createFromTicket/refresh auto-ingest as sync
   *  output, not work). Jira attachments and files extracted from a zip attachment are also
   *  origin 'jira' but carry no `jira.role`, so they count here like any other evidence — a
   *  human chose to download them, which is investigation work. */
  lastEvidenceAt: string | null
  /** MAX(turns.created_at) over sessions whose mode is `investigation`. */
  lastInvestigationAt: string | null
  /** MAX(findings.created_at) over sessions whose mode is `investigation`. */
  lastInvestigationFindingAt: string | null
  /** pr_bindings.detected_at — a case binds at most one PR. */
  prLinkedAt: string | null
  /** MAX(turns.created_at) over sessions whose mode is `review`. */
  lastReviewAt: string | null
  /** MAX(findings.created_at) over sessions whose mode is `review`. */
  lastReviewFindingAt: string | null
  /** MAX(evidence.created_at) over review-scoped evidence (artifacts/…, see
   *  shared/evidenceScope.ts's scopeOfRelPath) — e.g. a CI log fetched mid-review. Without
   *  this, review-scoped evidence fell into `lastEvidenceAt` and read as `analyzing`. Same
   *  Jira ticket-mirror exclusion as `lastEvidenceAt` describes applies here too — mirror
   *  rows never actually land under artifacts/, but the underlying query excludes them from
   *  both buckets alike. */
  lastReviewEvidenceAt: string | null
  /** cases.phase_pin — null unless something declared a non-derivable phase. */
  phasePin: CasePhasePin | null
  /** cases.phase_pinned_at — when it was declared. */
  phasePinnedAt: string | null
}

/**
 * Where the case is now: the phase of its most recent work event.
 *
 * Recency, not a high-water mark. This is the whole point — work on a case is not linear,
 * so returning to investigation after a review run must read `analyzing` again. Because
 * every signal is just a timestamp, undoing an action (unlinking a PR, clearing findings)
 * removes its signal rather than needing a compensating rule, and nothing can go stale.
 *
 * Deliberately NOT signals: Jira sync and PR-status polling (both fire in the background
 * and would reshuffle the dashboard while nobody is looking), `cases.updated_at` (bumped by
 * bookkeeping as well as work, so it cannot tell them apart), and mode switching (navigation,
 * not work). See shared/triage.ts's `hasUpstreamChange` for the same line drawn for the
 * overview header.
 */
export function derivePhase(s: PhaseSignals): CasePhase {
  // A closed case is closed however busy it looks. This is the one hard override.
  if (s.status === 'closed') return 'closed'

  // Most specific first. This order doubles as the tie-break: `>` below is strict, so an
  // earlier entry wins an exact timestamp collision. Without a fixed order the dashboard
  // could flicker between renders on two signals written in the same millisecond.
  const candidates: Array<readonly [string | null, CasePhase]> = [
    [s.phasePin ? s.phasePinnedAt : null, s.phasePin ?? 'open'],
    [s.lastReviewAt, 'reviewing'],
    [s.lastReviewFindingAt, 'reviewing'],
    [s.lastReviewEvidenceAt, 'reviewing'],
    [s.prLinkedAt, 'pr-created'],
    [s.lastInvestigationAt, 'analyzing'],
    [s.lastInvestigationFindingAt, 'analyzing'],
    [s.lastEvidenceAt, 'analyzing']
  ]

  let best: { at: string; phase: CasePhase } | null = null
  for (const [at, phase] of candidates) {
    if (at == null) continue
    // ISO 8601 UTC strings compare lexicographically = chronologically; listCases already
    // sorts on updatedAt this way. Do not parse to Date.
    if (best === null || at > best.at) best = { at, phase }
  }
  return best?.phase ?? 'open'
}
