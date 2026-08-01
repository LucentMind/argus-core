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
}): Promise<PacksListPayload> {
  const { state, registry, binaries, updates } = deps
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
      pendingRelaunch: installedVersion != null && installedVersion !== loadedVersion,
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
  return { packs, error: null }
}
