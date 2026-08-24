import type { ApplyOutcome, BlockedReason, Candidate } from '../../../../shared/currency'
import type { UpdateErrorCode, UpdateStatus } from '../../../../shared/updates'
import type { CurrencyAdapter } from './adapter'

/** Structural, not the PackUpdatesService class — the tests need no HTTP and no gh. */
export interface PackUpdatesLike {
  checkAll(): Promise<Record<string, UpdateStatus>>
  /** Deliberately one-argument: see `apply` below. */
  apply(id: string): Promise<UpdateStatus>
}

export interface PacksAdapterDeps {
  updates: PackUpdatesLike
  /** Installed packs, for the display name and the version a candidate is coming FROM. */
  installed: () => { id: string; displayName: string; installedVersion: string | null }[]
  /**
   * Mirrors what the `packsCheckUpdates` IPC handler does with its `checkAll()` result. Without
   * this, `survey()`'s own `checkAll()` call is a dead end: nothing outside this adapter ever
   * learns what it found, so `packsList`'s `updates` map — the thing that drives the "update
   * available" chip — never changes and the badge stays cold until someone presses the manual
   * "Check for pack updates" button.
   */
  onSurveyed?: (statuses: Record<string, UpdateStatus>) => void
  /**
   * Mirrors what the manual `packsApplyUpdate` IPC handler does with `packsTouched` after a
   * `ready` apply — called ONLY then, never on a refusal or an unresolved race (Important 5,
   * whole-branch review). Without this, `packsTouched` (which drives `relaunchRequired`, see
   * `packsService.ts`) never learns about an install this adapter's own `apply()` performed: the
   * pack is downloaded and installed on disk, the row flips to up-to-date, and the user keeps
   * running the OLD pack code with no "relaunch to finish" prompt — this path calls
   * `packUpdates.apply(id)` directly and never touches `packsTouched` on its own. Same shape as
   * `hiveAdapter`'s `onInstalled`.
   */
  onInstalled?: (id: string) => void
}

/**
 * A failure code that means "a person has to decide", as opposed to "the network was rude".
 * Everything absent from this map is transport noise and never reaches the user.
 */
function reasonOf(code: UpdateErrorCode | undefined): BlockedReason | null {
  switch (code) {
    case 'origin-pin':
      return { kind: 'origin-pin' }
    case 'gh-auth':
      return { kind: 'auth' }
    case 'gh-missing':
      return { kind: 'gh-missing' }
    case 'gh-notfound':
      return { kind: 'gh-notfound' }
    case 'gh-forbidden':
      return { kind: 'gh-forbidden' }
    // 'gh-failed' is deliberately absent: it is classifyGhFailure's catch-all for a gh call that
    // failed for no attributable reason (rate-limited, a malformed response, a mid-call network
    // blip). None of those is a decision a person can act on, so — like every OTHER code absent
    // from this map — it is transport noise, not a `BlockedReason`, and is silently re-offered by
    // the next survey rather than surfacing a sentence that would send the user chasing a sign-in
    // or an install that was never the problem.
    default:
      return null
  }
}

export function createPacksAdapter({
  updates,
  installed,
  onSurveyed,
  onInstalled
}: PacksAdapterDeps): CurrencyAdapter {
  return {
    id: 'packs',

    async survey(): Promise<Candidate[]> {
      const statuses = await updates.checkAll()
      onSurveyed?.(statuses)
      const rows = new Map(installed().map((p) => [p.id, p]))
      const out: Candidate[] = []
      for (const [id, status] of Object.entries(statuses)) {
        const row = rows.get(id)
        // A status for something not installed cannot be described (no name, no from-version)
        // and cannot be applied. Skip rather than invent.
        if (!row) continue
        const base = { domain: 'pack' as const, key: id, label: row.displayName }
        if (status.phase === 'available')
          out.push({
            ...base,
            from: row.installedVersion,
            to: status.version,
            verdict: 'clean'
          })
        else if (status.phase === 'error') {
          const reason = reasonOf(status.code)
          if (!reason) continue
          out.push({
            ...base,
            from: row.installedVersion,
            to: row.installedVersion ?? '',
            verdict: 'blocked',
            reason
          })
        }
      }
      return out
    },

    /**
     * Applies with NO `ApplyHooks`.
     *
     * That single omission is the whole unattended policy for packs: `PackUpdatesService.apply`
     * refuses an update whose dependencies are unsatisfied unless the caller supplies
     * `planUnsatisfied` to stage a plan — and a plan needs someone to approve it. The manual
     * Update button passes the hook; this never does.
     */
    async apply(c: Candidate): Promise<ApplyOutcome> {
      const status = await updates.apply(c.key)
      // `ready` — and ONLY `ready` — means the install actually happened. "Not an error" is not
      // the same thing: `PackUpdatesService.apply` returns `{ phase: 'idle' }` with no error at
      // all when `findUpdate` finds nothing, which is exactly what happens when the world moved
      // between the survey and here. Reporting success on "not error" would claim a pack was
      // updated when nothing was written.
      if (status.phase === 'ready') {
        onInstalled?.(c.key)
        return { ok: true, needsRelaunch: true }
      }
      if (status.phase === 'error') {
        const reason =
          reasonOf(status.code) ??
          // `install` is what an unsatisfied-dependency refusal surfaces as once the hook is
          // absent: the bytes were fetched and verified, and installPack declined them.
          (status.code === 'install' ? ({ kind: 'new-dependency' } as const) : null)
        return reason
          ? { ok: false, error: status.message, reason }
          : { ok: false, error: status.message }
      }
      // Any other phase is that race, not a decision for the user: no `reason`, so the service
      // drops it silently and the next survey re-offers it.
      return { ok: false, error: `pack update was no longer available to apply (${status.phase})` }
    }
  }
}
