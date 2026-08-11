import type { DatabaseSync } from 'node:sqlite'
import type { PermissionMode } from '../../../shared/settings'
import { requestedPermissionMode, sessionPermissionMode, sessionProvider } from './sessionStore'

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
    // queryOptions.ts's buildRunOptionQueryFields deliberately OMITS `permissionMode` from the
    // SDK options when it is 'default' — Argus asks the CLI for nothing and lets it use
    // whatever it's configured for (including an enterprise `permissions.defaultMode`). So
    // 'default' is never actually a REQUEST the CLI can refuse; recording it here would blame
    // a mismatch on a request Argus never made, and disable "Ask approvals" — the safest mode
    // and the one every unpinned session inherits. If queryOptions.ts's omission rule ever
    // changes, this guard has to change with it.
    if (requested === 'default') return
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

export interface RecordRefusalDeps {
  db: DatabaseSync
  registry: ModeRefusalRegistry
  /** `settingsService.get().agent.defaultPermissionMode` at the moment the event fired —
   *  resolved by the caller, not read here, so this function has no settings dependency. */
  defaultPermissionMode: PermissionMode
}

export interface SessionStartedRefusalEvent {
  sessionId: number
  /** Whatever the CLI's own init message reported adopting; `null` means it said nothing. */
  effectivePermissionMode: string | null
}

/**
 * The one place "what Argus asked for" meets "what the CLI actually adopted" — extracted out
 * of main/index.ts's `AgentService` `onEvent` sink so this comparison has a unit test reaching
 * it directly, instead of depending on the whole app's IPC/event wiring to exercise it. Two
 * things have to line up exactly for a genuine refusal to be recorded, and either one silently
 * breaking would make the detector silently stop detecting:
 *
 * 1. The instance lookup (`sessionProvider` — events carry no `instanceId`, only
 *    `caseSlug`/`sessionId`).
 * 2. The requested-mode fallback (`requestedPermissionMode`), which MUST be the exact same
 *    expression `registry.ts` uses to build the driver's options — sharing the function
 *    (rather than each side hand-writing `sessionPerm ?? defaultPermissionMode`) is what makes
 *    that guaranteed rather than merely intended.
 *
 * No-op when the session has no known instance (a row that predates multi-provider) — there is
 * nothing to attribute a refusal to.
 */
export function recordRefusalFor(deps: RecordRefusalDeps, event: SessionStartedRefusalEvent): void {
  const instanceId = sessionProvider(deps.db, event.sessionId)?.instanceId
  if (!instanceId) return
  const requested = requestedPermissionMode(
    sessionPermissionMode(deps.db, event.sessionId),
    deps.defaultPermissionMode
  )
  deps.registry.record(instanceId, requested, event.effectivePermissionMode)
}
