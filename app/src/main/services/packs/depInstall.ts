import { installPack } from './install'
import type { StagedPack } from './depPlanner'
import type { PackSource, PacksStateStore } from './packsState'
import type { ApplyPlanResult, InstallResult } from '../../../shared/packs'

/** Exactly the slice of `installPack`'s options this module supplies. Declared as its own type
 *  so the injected fake and the real installer are checked against one signature — a structural
 *  mismatch here would otherwise only surface as an `as never` cast. */
export type InstallFn = (
  source: string,
  opts: {
    argusHome: string
    state: PacksStateStore
    host?: { platform: string; arch: string }
    alsoInstalling?: ReadonlySet<string>
    pinOverride?: PackSource | null
  }
) => Promise<InstallResult>

export interface ApplyPlanDeps {
  argusHome: string
  state: PacksStateStore
  host?: { platform: string; arch: string }
  /** Ids whose pin must not be overwritten — see `pinFor`. */
  existingPins?: Record<string, PackSource | undefined>
  /** Injected for tests; defaults to the real installer. */
  install?: InstallFn
}

/** A declared source becomes a real pin only here, where `installedAt` is finally true. */
function pinFor(pack: StagedPack, now: number): PackSource | undefined {
  if (pack.source == null) return undefined // derive from the manifest, as a plain install does
  return pack.source.kind === 'feed'
    ? {
        kind: 'feed',
        origin: pack.source.origin,
        updateUrl: pack.source.updateUrl,
        installedAt: now
      }
    : {
        kind: 'github',
        host: pack.source.host,
        owner: pack.source.owner,
        repo: pack.source.repo,
        installedAt: now
      }
}

/**
 * Installs an approved plan in order, stopping at the first failure.
 *
 * Dependencies precede dependents in the plan, so a stop can never leave the requesting pack
 * installed without what it needs — the invariant comes from the ordering, not from cleanup. A
 * dependency that landed is a valid standalone pack and the guard already proved it broke nothing,
 * so it is kept rather than rolled back.
 */
export async function applyPlan(
  deps: ApplyPlanDeps,
  packs: StagedPack[]
): Promise<ApplyPlanResult> {
  const install: InstallFn = deps.install ?? installPack
  const alsoInstalling = new Set(packs.map((p) => p.id))
  const installed: Array<{ id: string; version: string }> = []
  const now = Date.now()

  for (const pack of packs) {
    // An existing pin outranks a dependent's declared source: without this, a hostile pack
    // declaring a dependency on a legitimate id could re-point it at another host.
    const existing = deps.existingPins?.[pack.id]
    const res = await install(pack.bundlePath, {
      argusHome: deps.argusHome,
      state: deps.state,
      host: deps.host,
      alsoInstalling,
      pinOverride: existing ?? pinFor(pack, now)
    })
    if (!res.ok) {
      return {
        installed,
        failed: { id: pack.id, error: res.error },
        relaunchRequired: installed.length > 0
      }
    }
    installed.push({ id: pack.id, version: pack.version })
  }

  return { installed, failed: null, relaunchRequired: installed.length > 0 }
}
