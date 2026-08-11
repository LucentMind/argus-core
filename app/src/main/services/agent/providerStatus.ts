import type { AgentSettings } from '../../../shared/settings'
import type { ProviderStatus } from '../../../shared/types'
import { driverConfig, enabledInstances, type AgentDriverConfig } from '../../../shared/drivers'
import type { AgentDriver } from './driver'
import type { ModeRefusalRegistry } from './modeRefusals'

export interface ProviderStatusDeps {
  settings: () => AgentSettings
  /** Driver for an instance id — injected (not a driverRegistry import) so tests can
   *  supply fakes without booting a real CLI transport. */
  driverFor: (instanceId: string) => AgentDriver | null
  /** Fired whenever the cached statuses change, so the renderer can re-read. */
  notify: () => void
  /** Injectable clock — the "Checked Xm ago" label is derived from these timestamps. */
  now?: () => Date
  /** Latest published version for a driver, or null when unknown/offline. */
  latestVersion?: (driverKind: string) => Promise<string | null>
  /** In-memory record of permission modes the CLI has refused to adopt this app session,
   *  per instance — injected the same way as `driverFor`/`latestVersion` so tests can
   *  observe it without wiring a real session sink. Optional so existing callers that
   *  don't care about refusals need not construct one. */
  modeRefusals?: ModeRefusalRegistry
}

/**
 * Per-provider-instance auth status, cached and refreshed.
 *
 * Distinct from `AuthCache`, which answers "can the DEFAULT provider run a turn" for one
 * instance and folds in turn evidence. This service answers "what is each configured
 * provider's state" for the settings page, where every enabled instance is listed at once.
 * Kept separate rather than generalising AuthCache because the two have different
 * invalidation rules: AuthCache must yield to turn evidence, this one must not (a turn on
 * provider A says nothing about provider B).
 */
export class ProviderStatusService {
  private cache = new Map<string, ProviderStatus>()
  private inFlight = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private deps: ProviderStatusDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /** Cached statuses for every enabled instance, in settings order. Instances never yet
   *  probed appear as `checking` rather than being omitted, so the list doesn't reflow.
   *
   *  Mode refusals are overlaid here, at read time, rather than baked into the cached status
   *  at probe time: `probe()` runs on a 5-minute timer/settings-change cadence, but a refusal
   *  can be recorded from a `session.started` event at any moment in between, so snapshotting
   *  it into the cache would leave it invisible until the next probe. Reading it fresh on
   *  every `list()` call also sidesteps any ordering question between when a probe runs and
   *  when the registry is cleared — there is nothing to get out of order. */
  list(): ProviderStatus[] {
    return enabledInstances({ agent: this.deps.settings() } as never).map(
      ({ id, instance, driver }) => {
        const status = this.cache.get(id) ?? {
          instanceId: id,
          driverKind: driver.kind,
          displayName: instance.displayName?.trim() || (driver.shortLabel ?? driver.label),
          state: 'checking',
          detail: 'Checking provider status',
          checkedAt: null
        }
        // Undefined (not []) when clean, so a status with nothing to report is byte-identical
        // to before this field existed.
        const refused = this.deps.modeRefusals?.for(id)
        return refused && refused.length > 0
          ? { ...status, refusedPermissionModes: refused }
          : status
      }
    )
  }

  /** Probe one instance. Concurrent calls for the same instance share one probe. */
  async refreshOne(instanceId: string): Promise<void> {
    const existing = this.inFlight.get(instanceId)
    if (existing) return existing
    const run = this.probe(instanceId).finally(() => this.inFlight.delete(instanceId))
    this.inFlight.set(instanceId, run)
    return run
  }

  /** Probe every enabled instance concurrently — one provider being slow or wedged must not
   *  delay the others' results, so each notifies as it lands.
   *
   *  Does NOT clear the mode-refusal registry. This runs on a 5-minute timer and on every
   *  settings write (`onSettingsChanged`), neither of which is evidence the underlying org
   *  policy changed — clearing here would make a still-true refusal evaporate within five
   *  minutes. Only a user-initiated refresh (the `IPC.providerRefresh` handler) clears the
   *  registry, because that is the one gesture the design intends to mean "policy may have
   *  changed, go find out." */
  async refreshAll(): Promise<void> {
    const agent = this.deps.settings()
    await Promise.all(
      enabledInstances({ agent } as never).map(({ id }) => this.refreshOne(id).catch(() => {}))
    )
  }

  private async probe(instanceId: string): Promise<void> {
    const agent = this.deps.settings()
    const instance = agent.providerInstances[instanceId]
    const driver = this.deps.driverFor(instanceId)
    if (!instance || !driver) {
      this.cache.delete(instanceId)
      this.deps.notify()
      return
    }
    const displayName = instance.displayName?.trim() || driver.kind
    const cfg = driverConfig<AgentDriverConfig>(instance.driver, instance.config)
    try {
      const r = await driver.probeAuth({
        timeoutMs: agent.probeTimeoutMs,
        cliPath: cfg.cliPath
      })
      const latest = r.version
        ? await this.deps.latestVersion?.(driver.kind).catch(() => null)
        : null
      this.cache.set(instanceId, {
        instanceId,
        driverKind: driver.kind,
        displayName,
        state: r.ok ? 'ready' : 'error',
        detail: r.detail,
        email: r.email,
        subscription: r.subscription,
        version: r.version,
        // Only an advisory — never auto-updated. A null `latest` (offline, unknown package)
        // simply means no arrow is shown, rather than a scary "unknown" state.
        latestVersion: latest && r.version && latest !== r.version ? latest : undefined,
        updateCommand: driver.updateCommand,
        ...(r.ok ? {} : { fixHint: driver.authFixHint }),
        checkedAt: this.now().toISOString()
      })
    } catch (err) {
      this.cache.set(instanceId, {
        instanceId,
        driverKind: driver.kind,
        displayName,
        state: 'error',
        detail: err instanceof Error ? err.message : String(err),
        fixHint: driver.authFixHint,
        checkedAt: this.now().toISOString()
      })
    }
    this.deps.notify()
  }

  /**
   * Begin periodic re-probing. Status goes stale silently otherwise — a user who runs
   * `claude login` in a terminal expects the settings page to notice without a restart.
   * `unref` so the interval never holds the process open.
   */
  start(intervalMs = 5 * 60_000): void {
    if (this.timer) return
    void this.refreshAll()
    this.timer = setInterval(() => void this.refreshAll(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Drop cached statuses for instances that no longer exist or were switched off, and
   *  re-probe the rest — called when settings change. */
  onSettingsChanged(): void {
    const live = new Set(
      enabledInstances({ agent: this.deps.settings() } as never).map((e) => e.id)
    )
    for (const id of [...this.cache.keys()]) if (!live.has(id)) this.cache.delete(id)
    void this.refreshAll()
  }
}
