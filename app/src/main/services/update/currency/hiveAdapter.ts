import type {
  ApplyOutcome,
  BlockedReason,
  Candidate,
  CurrencyDomain
} from '../../../../shared/currency'
import type { HivemindPayload, LocalDivergence } from '../../../../shared/hivemind'
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
}

const domainOf = (kind: 'skill' | 'reference'): CurrencyDomain =>
  kind === 'skill' ? 'hive-skill' : 'hive-reference'

/** The one place a tombstone/candidate key is spelled on this side of the wire. */
const keyOf = (kind: 'skill' | 'reference', name: string): string => `${kind}/${name}`

/** Split a candidate key back into its parts. Keys are built by `keyOf`, so this always matches. */
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

export function createHiveAdapter({ service }: HiveAdapterDeps): CurrencyAdapter {
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
        if (isNew && declined[keyOf(it.kind, it.name)]) continue

        const base = {
          domain: domainOf(it.kind),
          key: keyOf(it.kind, it.name),
          label: it.name,
          from: it.installedCommit,
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
      return { ok: true }
    }
  }
}
