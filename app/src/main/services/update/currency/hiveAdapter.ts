import type {
  ApplyOutcome,
  BlockedReason,
  Candidate,
  CurrencyDomain
} from '../../../../shared/currency'
import type { HivemindPayload, LocalDivergence } from '../../../../shared/hivemind'
import { declineKey } from '../../hivemind'
import type { CurrencyAdapter } from './adapter'

/** Structural, not the HivemindService class — the tests need no git and no clone. */
export interface HivemindLike {
  sync(): Promise<HivemindPayload>
  payload(): Promise<HivemindPayload>
  localDivergence(name: string): Promise<LocalDivergence>
  install(
    kind: 'skill' | 'reference',
    name: string,
    opts?: { overwriteLocalEdits?: boolean }
  ): Promise<HivemindPayload>
  declined(): Record<string, string>
}

export interface HiveAdapterDeps {
  service: HivemindLike
  /**
   * Mirrors the broadcasts the manual `hivemindInstall` IPC handler performs after a successful
   * `service.install()` — called ONLY when `apply()` actually installed something, never on a
   * refusal (blocked candidate) or a thrown/`.error` install. Without this, an auto-adopted skill
   * or reference sits on disk but stays invisible to the renderer (skills list / Library) until
   * the window is reloaded, because those lists fetch once and are otherwise only refreshed by
   * the broadcast this fires.
   */
  onInstalled?: (kind: 'skill' | 'reference', name: string) => void
}

const domainOf = (kind: 'skill' | 'reference'): CurrencyDomain =>
  kind === 'skill' ? 'hive-skill' : 'hive-reference'

// The tombstone/candidate key is spelled by `declineKey`, imported from the HiveMind service —
// NOT re-derived here. That function's own comment calls itself "the one place a tombstone key is
// spelled, so the ledger and the mirror cannot disagree"; a local copy would make that false, and
// changing the separator on one side would silently make the mirror miss every tombstone and
// re-install everything the user deliberately removed. No type error, no failing test.

/** Split a candidate key back into its parts. Keys are built by `declineKey`, so this matches.
 *  `indexOf` (FIRST slash), never `lastIndexOf`: a reference name may itself contain a slash,
 *  e.g. `reference/confluence/foo.md` must split to kind `reference`, name `confluence/foo.md`. */
function partsOf(key: string): { kind: 'skill' | 'reference'; name: string } {
  const i = key.indexOf('/')
  return { kind: key.slice(0, i) as 'skill' | 'reference', name: key.slice(i + 1) }
}

/**
 * Only a REFERENCE can diverge or be restamped: skills are whole directories installed under
 * `skills-hivemind/`, with no local-edit story and no trust tier. Returns null when there is
 * nothing to hold the item back for.
 */
async function referenceBlock(
  service: HivemindLike,
  kind: 'skill' | 'reference',
  name: string
): Promise<BlockedReason | null> {
  if (kind !== 'reference') return null
  const d = await service.localDivergence(name)
  if (d.diverged) return { kind: 'local-edits' }
  if (d.tierChange) return { kind: 'tier-change', from: d.tierChange.from, to: d.tierChange.to }
  return null
}

export function createHiveAdapter({ service, onInstalled }: HiveAdapterDeps): CurrencyAdapter {
  return {
    id: 'hive',

    async survey(): Promise<Candidate[]> {
      // Sync first: every verdict below is about the clone's HEAD, so a stale clone would
      // classify against yesterday's hive.
      const payload = await service.sync()
      if (payload.state !== 'ready') return []
      const declined = service.declined()
      const out: Candidate[] = []
      for (const it of payload.items) {
        // An orphan is installed and no longer offered — there is nothing upstream to apply.
        if (it.orphaned) continue
        // The mirror adopts anything not installed, EXCEPT what the user removed on purpose.
        const isNew = !it.installed
        if (!isNew && !it.updateAvailable) continue
        if (isNew && declined[declineKey(it.kind, it.name)]) continue

        const base = {
          domain: domainOf(it.kind),
          key: declineKey(it.kind, it.name),
          label: it.name,
          // `installed` is read from the FILESYSTEM while `installedCommit` is read from the
          // state file, so they genuinely disagree: delete a skill directory by hand (rather
          // than through the app, which is what clears the pin) and the item comes back
          // `installed: false` with its old pin still set. `from` must follow `installed`, or an
          // adoption would carry a version it is not actually coming from — and Increment 2
          // detects adoptions with `from === null`.
          from: it.installed ? it.installedCommit : null,
          to: it.commit
        }
        const reason = await referenceBlock(service, it.kind, it.name)
        out.push(reason ? { ...base, verdict: 'blocked', reason } : { ...base, verdict: 'clean' })
      }
      return out
    },

    /**
     * RE-DERIVES before writing. The survey that produced this candidate may be hours old, and in
     * that time the user may have edited the very reference this is about to overwrite. Installing
     * on the strength of a stale verdict is exactly the failure the divergence check exists to
     * prevent.
     *
     * Installs WITHOUT `overwriteLocalEdits`, so `HivemindService`'s own guard is a second,
     * independent line of defence behind this one.
     */
    async apply(c: Candidate): Promise<ApplyOutcome> {
      const { kind, name } = partsOf(c.key)
      const reason = await referenceBlock(service, kind, name)
      if (reason !== null) {
        // Written as an if/else rather than a ternary so TypeScript narrows `reason` to the
        // tier-change variant before `from`/`to` are read.
        let error: string
        if (reason.kind === 'tier-change')
          error = `${name} would be restamped from ${reason.from} to ${reason.to}`
        else error = `${name} was edited locally since it was checked`
        return { ok: false, error, reason }
      }
      const after = await service.install(kind, name)
      if (after.error) return { ok: false, error: after.error }
      onInstalled?.(kind, name)
      return { ok: true }
    }
  }
}
