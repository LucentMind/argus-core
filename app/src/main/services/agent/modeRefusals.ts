import type { PermissionMode } from '../../../shared/settings'

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

  /**
   * `effective` is whatever the CLI's own init message reported adopting, or `null`/`undefined`
   * when the driver said nothing (untyped at the JSON boundary — see mirror.ts's bare
   * `JSON.parse`). Silence is not a refusal: only an explicit mismatch is.
   */
  record(instanceId: string, requested: PermissionMode, effective: string | null): void {
    if (effective == null) return
    if (effective === requested) return
    const set = this.refusals.get(instanceId) ?? new Set<PermissionMode>()
    set.add(requested)
    this.refusals.set(instanceId, set)
  }

  /** Refused modes for one instance, insertion order. Empty array, never omitted, when clean. */
  for(instanceId: string): PermissionMode[] {
    return [...(this.refusals.get(instanceId) ?? [])]
  }

  clear(): void {
    this.refusals.clear()
  }
}
