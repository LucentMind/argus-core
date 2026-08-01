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
 * Until this branch, `permissionMode: 'bypassPermissions'` reached the SDK unpaired with
 * `allowDangerouslySkipPermissions`, which made it inert — the setting existed, users could
 * select it, and nothing happened. Now the pair is sent and it genuinely bypasses every
 * permission check (plausibly including `canUseTool`, and therefore Argus's own `tool_calls`
 * audit rows). Anyone who once set "Bypass approvals" as their global default, observed no
 * effect and left it there would get unprompted tool execution the moment they upgraded,
 * without ever making that choice against the behaviour it now has. So it is reset, and they
 * re-select it deliberately if they want it.
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
