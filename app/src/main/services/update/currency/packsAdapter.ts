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
}

/**
 * A failure code that means "a person has to decide", as opposed to "the network was rude".
 * Everything absent from this map is transport noise and never reaches the user.
 */
function reasonOf(code: UpdateErrorCode | undefined): BlockedReason | null {
  switch (code) {
    case 'origin-pin':
      return { kind: 'origin-pin' }
    case 'gh':
      return { kind: 'auth' }
    default:
      return null
  }
}

export function createPacksAdapter({ updates, installed }: PacksAdapterDeps): CurrencyAdapter {
  return {
    id: 'packs',

    async survey(): Promise<Candidate[]> {
      const statuses = await updates.checkAll()
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
      // A pack whose files changed under a running app needs a relaunch to be picked up.
      return { ok: true, needsRelaunch: true }
    }
  }
}
