import type { PermissionMode } from '../../../shared/settings'

export interface ModeRefusalRegistryDeps {
  /** Fired synchronously whenever `record()` adds a NEW refusal (not on no-ops, and not on a
   *  repeat refusal of a mode already recorded for that instance). This is the only way a
   *  refusal reaches the renderer without waiting for the next periodic/settings-driven
   *  `refreshAll()` — which can be up to five minutes away — or a user-initiated refresh.
   *  Optional so tests that don't care about notification don't need to supply one. */
  notify?: () => void
}

/**
 * In-memory record of "Argus asked this provider instance for permission mode X, the CLI
 * adopted something else instead". Never persisted: an org's Claude Code policy can change
 * (or the CLI can be pointed at a different install) between app launches, and a stale
 * disable surviving a restart is worse than one that clears and has to be re-observed.
 *
 * Deliberately dumb — a `Map<string, Set<PermissionMode>>` with no comparison logic beyond
 * string equality. The actual "was this refused" judgment (matching `effectivePermissionMode`
 * against what was requested, treating `null`/`undefined` as "no report" rather than a
 * refusal) lives in the caller, because only the caller has both values in scope at the
 * `session.started` event.
 */
export class ModeRefusalRegistry {
  private refusals = new Map<string, Set<PermissionMode>>()

  constructor(private deps: ModeRefusalRegistryDeps = {}) {}

  /**
   * `effective` is whatever the CLI's own init message reported adopting, or `null`/`undefined`
   * when the driver said nothing (untyped at the JSON boundary — see mirror.ts's bare
   * `JSON.parse`). Silence is not a refusal: only an explicit mismatch is.
   */
  record(instanceId: string, requested: PermissionMode, effective: string | null): void {
    if (effective == null) return
    if (effective === requested) return
    const set = this.refusals.get(instanceId) ?? new Set<PermissionMode>()
    const isNew = !set.has(requested)
    set.add(requested)
    this.refusals.set(instanceId, set)
    if (isNew) this.deps.notify?.()
  }

  /** Refused modes for one instance, insertion order. Empty array, never omitted, when clean. */
  for(instanceId: string): PermissionMode[] {
    return [...(this.refusals.get(instanceId) ?? [])]
  }

  clear(): void {
    this.refusals.clear()
  }
}
