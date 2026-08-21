import type { AppSettings } from '../../shared/settings'

/** The slice of `SettingsService` a migration needs. Injected rather than imported so these
 *  stay unit-testable without an Electron app object — same shape `ensureTrackingStarted`
 *  (services/observability/usage.ts) takes. */
export interface MigratableSettings {
  get(): AppSettings
  patch(p: unknown): AppSettings
}

/**
 * One-time upgrade: retire a stored `bypassPermissions` DEFAULT.
 *
 * Until this branch, on the Claude driver specifically, `permissionMode: 'bypassPermissions'`
 * reached the SDK unpaired with `allowDangerouslySkipPermissions`, which made it inert there —
 * the setting existed, users could select it, and nothing happened. Now the pair is sent and it
 * genuinely bypasses every permission check (plausibly including `canUseTool`, and therefore
 * Argus's own `tool_calls` audit rows).
 *
 * This is a deliberate fail-safe, not a universal bug fix: the Copilot, ACP, and Codex drivers
 * already honoured `bypassPermissions` correctly before this branch (see their own
 * `ctx.permissionMode === 'bypassPermissions'` short-circuits), so a user on one of those who
 * deliberately set Bypass and watched it work will still have it reset here on upgrade. That
 * reset is intentional — this migration cannot tell "set once, forgotten, now surprising" apart
 * from "set on purpose, working as intended" across drivers, and getting the Claude case wrong
 * (unprompted tool execution nobody chose against today's behaviour) is worse than the Copilot
 * case wrong (a working setting needs one re-select). So it resets everyone's stored default
 * uniformly, and they re-select it deliberately if they want it.
 *
 * Idempotent via the `migrations.bypassDefaultReset` stamp — the same "sentinel key, written
 * once" shape as `ensureTrackingStarted`'s tracking epoch. The stamp is written even when
 * nothing needed resetting: without that, a user who later chose Bypass on purpose would
 * have it silently taken away again at the next startup.
 *
 * Touches `agent.defaultPermissionMode` and the stamp only. Per-SESSION permission modes
 * (`sessions.permission_mode`) are deliberately untouched: those are chosen per chat, in the
 * composer, against the behaviour of the moment — not a stale global left over from when the
 * setting did nothing.
 */
export function migrateBypassDefault(
  settings: MigratableSettings,
  now: () => Date = () => new Date()
): void {
  const current = settings.get()
  if (current.migrations.bypassDefaultReset) return
  const wasBypass = current.agent.defaultPermissionMode === 'bypassPermissions'
  settings.patch({
    migrations: { bypassDefaultReset: now().toISOString() },
    ...(wasBypass ? { agent: { defaultPermissionMode: 'default' as const } } : {})
  })
  if (wasBypass) {
    console.warn(
      '[settings] agent.defaultPermissionMode was "bypassPermissions", which is no longer ' +
        'inert — it now skips every permission check. Reset to "default"; re-select ' +
        '"Bypass approvals" in Settings if you want it.'
    )
  }
}

/**
 * One-time upgrade: fold the single `general.defaultRepo` into the `general.defaultRepos` list.
 *
 * The legacy key is nulled unconditionally, not just when it was adopted. A patch value of
 * `null` DELETES the key (see `deepMerge`), and null is also the schema default, so the key
 * vanishes from disk on the next write instead of lingering as a second, stale source of
 * truth. Leaving it would resurrect the old default for any user who later empties the list.
 *
 * Idempotent via the `migrations.defaultRepoToList` stamp — the same "sentinel key, written
 * once" shape as `migrateBypassDefault`. The stamp is written even when there was nothing to
 * move, so a user who deliberately clears the list later never has it refilled.
 */
export function migrateDefaultRepoToList(
  settings: MigratableSettings,
  now: () => Date = () => new Date()
): void {
  const current = settings.get()
  if (current.migrations.defaultRepoToList) return
  const legacy = current.general.defaultRepo
  const adopt = legacy !== null && current.general.defaultRepos.length === 0
  settings.patch({
    migrations: { defaultRepoToList: now().toISOString() },
    general: { defaultRepo: null, ...(adopt ? { defaultRepos: [legacy] } : {}) }
  })
}

/**
 * One-time upgrade: split `general.similarPastCasesEnabled` into the two switches that replaced
 * it (`relatedSearchOnOpen` + `relatedIncludeLocalCases`).
 *
 * The old flag gated ONE source — this install's own past cases — while corpus providers
 * searched on every case open regardless. The new pair keeps that behaviour on upgrade: the
 * master defaults on (corpora keep searching), and the old value carries across to the
 * local-cases switch, so a user who had turned local history on keeps it and a user who never
 * touched it sees no change at all.
 *
 * The legacy key is nulled unconditionally — `null` deletes it (see `deepMerge`) and `false` is
 * its schema default, so it leaves disk rather than lingering as a second source of truth.
 *
 * Idempotent via the `migrations.relatedSearchSwitches` stamp, written even when there was
 * nothing to carry across: without that, a user who later turns local history off would have it
 * switched back on at the next launch.
 */
export function migrateRelatedSearchSwitches(
  settings: MigratableSettings,
  now: () => Date = () => new Date()
): void {
  const current = settings.get()
  if (current.migrations.relatedSearchSwitches) return
  const legacy = current.general.similarPastCasesEnabled
  settings.patch({
    migrations: { relatedSearchSwitches: now().toISOString() },
    general: {
      similarPastCasesEnabled: null,
      ...(legacy ? { relatedIncludeLocalCases: true } : {})
    }
  })
}
