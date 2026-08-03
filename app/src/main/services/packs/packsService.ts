import type { PackRegistry } from './registry'
import type { PacksStateStore } from './packsState'
import type { BinariesService } from './binaries'
import type { PacksListPayload, InstalledPackRow } from '../../../shared/packs'
import type { UpdateStatus } from '../../../shared/updates'

export async function listInstalledPacks(deps: {
  state: PacksStateStore
  registry: PackRegistry
  binaries: BinariesService
  /** Last known per-pack update statuses. Absent ⇒ every row reports null. */
  updates?: Record<string, UpdateStatus>
  /**
   * Pack ids written to disk since this process loaded `registry` — install, uninstall, or an
   * applied update. The caller owns the set and clears it by restarting, which is the only thing
   * that makes it false again.
   */
  touched?: ReadonlySet<string>
}): Promise<PacksListPayload> {
  const { state, registry, binaries, updates, touched } = deps
  const installed = state.list() // id -> version
  const loaded = new Map(registry.packs().map((p) => [p.id, p]))
  const probes = new Map((await binaries.probe()).map((r) => [r.id, r]))
  const ids = [...new Set([...Object.keys(installed), ...loaded.keys()])].sort()

  const packs: InstalledPackRow[] = ids.map((id) => {
    const lp = loaded.get(id)
    const installedVersion = installed[id] ?? null
    const loadedVersion = lp?.manifest.version ?? null
    const binDecls = lp ? registry.binaryDecls().filter((b) => b.packDir === lp.dir) : []
    return {
      id,
      displayName: lp?.manifest.displayName ?? id,
      installedVersion,
      loadedVersion,
      platform: lp?.manifest.platform ?? null,
      // `touched` is the authoritative half: it catches a same-version reinstall and an
      // uninstall, both of which the version comparison reports as settled. The comparison is
      // kept for what `touched` cannot see — a pack whose recorded version does not match what
      // the registry managed to load.
      pendingRelaunch:
        (touched?.has(id) ?? false) ||
        (installedVersion != null && installedVersion !== loadedVersion),
      update: updates?.[id] ?? null,
      binaries: binDecls.map(({ decl }) => {
        const pr = probes.get(decl.id)
        return {
          id: decl.id,
          displayName: decl.displayName,
          ok: pr?.ok ?? false,
          detail: pr?.detail ?? 'not found'
        }
      })
    }
  })
  return {
    packs,
    error: null,
    // `touched.size` is not redundant with the row scan: an uninstalled pack that never loaded
    // (so it has no registry entry either) leaves no row to carry the flag.
    relaunchRequired: (touched?.size ?? 0) > 0 || packs.some((p) => p.pendingRelaunch)
  }
}
