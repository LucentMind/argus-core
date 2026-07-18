import type { AgentSettings } from '../../../shared/settings'
import type { ProviderStatus } from '../../../shared/types'
import { driverConfig, enabledInstances, type AgentDriverConfig } from '../../../shared/drivers'
import type { AgentDriver } from './driver'

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
   *  probed appear as `checking` rather than being omitted, so the list doesn't reflow. */
  list(): ProviderStatus[] {
    return enabledInstances({ agent: this.deps.settings() } as never).map(
      ({ id, instance, driver }) =>
        this.cache.get(id) ?? {
          instanceId: id,
          driverKind: driver.kind,
          displayName: instance.displayName?.trim() || (driver.shortLabel ?? driver.label),
          state: 'checking',
          detail: 'Checking provider status',
          checkedAt: null
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
   *  delay the others' results, so each notifies as it lands. */
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
