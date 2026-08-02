import path from 'node:path'

/**
 * Cases backed by the real HiveMindTest clone: each gets a git worktree at its pull
 * request's head and a real `gh`-fetched status. Only these four can carry diff-anchored
 * findings that actually open code.
 */
export const REPO_SLUGS = [
  'HMT-1-burst-token',
  'HMT-9-quota-drift',
  'HMT-3-cancelled',
  'HMT-4-nochecks'
]

/**
 * Dashboard filler: database rows and a minimal case dir, no repo and no pull request.
 *
 * They deliberately bind NO pull request. `usePrStatuses` refreshes every binding on
 * dashboard mount and `refreshPrStatuses` is the only writer of pr_status_cache, so a
 * fabricated status for a pull request that does not exist is overwritten with
 * `unavailable` within a second of boot — a binding here would cost a real network round
 * trip to make the card look WORSE. Rollup variety comes from the four real pull requests
 * above instead.
 */
export const FILLER_SLUGS = [
  'NAV-212-route-flicker',
  'NAV-118-stopover-drop',
  'ADAS-77-lane-bias',
  'NAV-305-tile-cache'
]

export const SLUGS = [...REPO_SLUGS, ...FILLER_SLUGS]

export const PR_NUMBERS = {
  'HMT-1-burst-token': 4,
  'HMT-9-quota-drift': 6,
  'HMT-3-cancelled': 7,
  'HMT-4-nochecks': 5
}

/**
 * Hours before the run at which each event is stamped.
 *
 * A designed timeline, not wall-clock `now` everywhere, because `derivePhase`
 * (src/shared/casePhase.ts) returns the phase of the case's NEWEST signal. Stamping
 * everything with one `now` makes the phase a coin flip decided by module execution order
 * — and in particular makes every case read `pr-created`, because pull-request bindings are
 * written after sessions and findings. These offsets are what make each case land on the
 * phase badge it is supposed to demonstrate.
 *
 * Ordering that matters: REVIEW_FINDINGS must be newer than PR_LINKED (or the flagship
 * reads `pr-created` instead of `reviewing`), and RCA_PIN must be newer than every signal
 * on its own case (or the pin loses and `rca-drafted` never appears anywhere).
 */
export const T = {
  PRIOR_WORK: 336, // 14d — the prior case's investigation
  PRIOR_CLOSED: 330,
  CREATED: 72, // 3d — flagship opened
  INVESTIGATION: 48, // 2d — investigation turns
  INVESTIGATION_FINDINGS: 47,
  PR_LINKED: 36,
  REVIEW: 20,
  REVIEW_FINDINGS: 18, // newest signal on the flagship → phase 'reviewing'
  DISTILL: 12,
  PROPOSALS: 10,
  RCA_PIN: 6
}

/** Shared state every demo module receives. `db` is null in unit tests. */
export function createCtx({ argusHome, db }) {
  const t0 = Date.now()
  return {
    argusHome,
    db,
    SLUGS,
    REPO_SLUGS,
    FILLER_SLUGS,
    PR_NUMBERS,
    T,
    /** ISO timestamp `hoursAgo` before this run. Fractions are fine — turns inside one
     *  session are spread by minutes so the transcript reads in order. */
    at: (hoursAgo) => new Date(t0 - hoursAgo * 3600_000).toISOString(),
    nowIso: () => new Date(t0).toISOString(),
    caseDir: (slug) => path.join(argusHome, 'cases', slug),
    repoDir: (name) => path.join(argusHome, 'repos', name),
    /** Mirrors casePrWorktreeDir() in src/main/services/prWorktree.ts. */
    worktreeDir: (repo, slug, pr) => path.join(argusHome, 'worktrees', `${repo}-${slug}-pr${pr}`)
  }
}
