import {
  DIAGNOSTICS_SLOW_INTERVAL_MS,
  type DiagnosticsHistory,
  type DiagnosticsSnapshot,
  type ElectronProcessMetric,
  type SidecarHealth,
  type SidecarSnapshot
} from '../../../shared/diagnostics'
import { buildSnapshot, type BuildResult, type ProcessState } from './model'
import { DiagnosticsHistoryRing } from './history'
import type { ConnectorCommand, WindowDescriptor } from './labels'
import type { ProcessLabels } from './processLabels'

/** Page open: one sample a second. */
export const FAST_INTERVAL_MS = 1_000
/** Page closed: keep a low-rate heartbeat so history predates opening the page.
 *  Defined in shared/ because the renderer needs the same number to tell "sampled
 *  slowly" apart from "not sampling" when it draws a gap. */
export const SLOW_INTERVAL_MS = DIAGNOSTICS_SLOW_INTERVAL_MS

/** The surface DiagnosticsService needs from SidecarClient, so tests can fake it. */
export interface SidecarClientLike {
  start(): void
  stop(): void
  retry(): void
  setSampleInterval(ms: number): void
  sampleNow(requestId: string): void
  health(): SidecarHealth
  onSnapshot(cb: (s: SidecarSnapshot) => void): () => void
  /** Fires whenever the client's health() would return something new — status,
   *  restart count, or last error. Lets the service publish a fresh snapshot
   *  even when no sample has arrived, or when none ever will. */
  onHealthChange(cb: (h: SidecarHealth) => void): () => void
}

export type DiagnosticsServiceDeps = {
  client: SidecarClientLike
  /** The tree root — the Electron main process id, the same value passed to `configure`. */
  rootPid: number
  cores: number
  totalMemoryBytes: number
  getElectronMetrics: () => ElectronProcessMetric[]
  /** Live window/panel identities for tier-B naming. May throw; contained by ingest(). */
  getWindowDescriptors: () => WindowDescriptor[]
  /** Live configured stdio connectors, for tier-C MCP matching. */
  getConnectorCommands: () => ConnectorCommand[]
  /** Tier-A registry: authoritative labels Argus recorded at its own spawn sites. */
  processLabels: ProcessLabels
  /** Live owner keys of every Argus object that could own a tier-A process (session
   *  owner keys, pack-app case slugs) — the set a registered row's `owner` is checked
   *  against to detect orphans. */
  getLiveOwners: () => string[]
  /** Owner keys of every Argus object currently mid-turn, so a row can warn before it
   *  is stopped. Mirrors getLiveOwners in shape and in wiring. */
  getBusyOwners: () => string[]
  now?: () => number
}

/**
 * Owns cadence, delta state, and subscriber accounting.
 *
 * The subscriber set is keyed by webContents id rather than a bare count: with
 * more than one window open, closing the editor window must not stop sampling
 * for the main one.
 */
export class DiagnosticsService {
  private previous = new Map<string, ProcessState>()
  private peakRssBytes = 0
  private counters = { starts: 0, exits: 0 }
  private subscribers = new Set<number>()
  private current: DiagnosticsSnapshot | null = null
  private listeners: ((s: DiagnosticsSnapshot) => void)[] = []
  private unsubscribeClient: (() => void) | null = null
  private unsubscribeHealth: (() => void) | null = null
  private unsubscribeRegister: (() => void) | null = null
  private sampleNowSeq = 0
  /** Last status seen from the client, so publishHealth can detect a transition
   *  INTO 'healthy' rather than firing on every health event. */
  private lastHealthStatus: SidecarHealth['status'] | null = null
  private readonly ring = new DiagnosticsHistoryRing()

  constructor(private readonly deps: DiagnosticsServiceDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  start(): void {
    if (this.unsubscribeClient) return
    this.unsubscribeClient = this.deps.client.onSnapshot((s) => this.ingest(s))
    this.unsubscribeHealth = this.deps.client.onHealthChange((h) => this.handleHealthChange(h))
    // A registration landing on the slow tier must not wait up to 15s for the next
    // tick — three times the pin tolerance — or a driver started while the page is
    // closed would expire before it was ever pinned.
    this.unsubscribeRegister = this.deps.processLabels.onRegister(() =>
      this.deps.client.sampleNow(`reg-${++this.sampleNowSeq}`)
    )
    this.deps.client.start()
    this.applyCadence()
    // Publish immediately so latest() is never null after startup — including
    // when there is no working sidecar and no sample will ever arrive. This is
    // the baseline reading, not a transition, so it goes straight to
    // publishHealth() rather than through handleHealthChange()'s resync check.
    const initialHealth = this.deps.client.health()
    this.lastHealthStatus = initialHealth.status
    this.publishHealth(initialHealth)
  }

  stop(): void {
    this.unsubscribeClient?.()
    this.unsubscribeClient = null
    this.unsubscribeHealth?.()
    this.unsubscribeHealth = null
    this.unsubscribeRegister?.()
    this.unsubscribeRegister = null
    this.deps.client.stop()
    this.lastHealthStatus = null
  }

  latest(): DiagnosticsSnapshot | null {
    return this.current
  }

  history(windowMs: number): DiagnosticsHistory {
    return this.ring.read(this.now(), windowMs)
  }

  onSnapshot(cb: (s: DiagnosticsSnapshot) => void): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }

  subscribe(webContentsId: number): void {
    const had = this.subscribers.size > 0
    this.subscribers.add(webContentsId)
    if (!had) this.applyCadence()
  }

  unsubscribe(webContentsId: number): void {
    if (!this.subscribers.delete(webContentsId)) return
    if (this.subscribers.size === 0) this.applyCadence()
  }

  retrySidecar(): void {
    this.deps.client.retry()
  }

  /**
   * A registration's on-register sampleNow() (see start()) can be dropped on
   * the floor if the sidecar is mid-restart when it fires — send() in
   * SidecarClient is a no-op without a live, handshaken child, and restart
   * backoff runs up to 10s, well past the 5s pin tolerance. Once the client
   * comes back to 'healthy' any such drop is otherwise permanent: the unpinned
   * entry has already expired. Firing one resync sample on the transition
   * closes that window. Only the transition matters — a flapping sidecar that
   * reports 'healthy' repeatedly must not storm sampleNow.
   */
  private handleHealthChange(health: SidecarHealth): void {
    const wasHealthy = this.lastHealthStatus === 'healthy'
    this.lastHealthStatus = health.status
    if (!wasHealthy && health.status === 'healthy') {
      this.deps.client.sampleNow(`reg-resync-${++this.sampleNowSeq}`)
    }
    this.publishHealth(health)
  }

  /**
   * Republish on a health transition — a healthy sidecar going degraded or
   * unavailable mid-session, a disabled/unavailable sidecar recovering, etc.
   * With a real sample already in hand, keep it and just refresh sidecar
   * health so the page doesn't silently go stale. With no sample yet (no
   * working sidecar, or none has arrived so far), emit an honest empty
   * snapshot instead of leaving latest() null forever.
   */
  private publishHealth(health: SidecarHealth): void {
    this.current = this.current
      ? { ...this.current, readAt: this.now(), sidecar: health }
      : {
          readAt: this.now(),
          sampleIntervalMs: this.subscribers.size > 0 ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS,
          cores: this.deps.cores,
          totalMemoryBytes: this.deps.totalMemoryBytes,
          footprint: {
            processCount: 0,
            cpuPercent: 0,
            rssBytes: 0,
            peakRssBytes: 0,
            starts: 0,
            exits: 0,
            orphanCount: 0
          },
          objects: [],
          tree: [],
          sidecar: health
        }
    for (const l of this.listeners) l(this.current)
  }

  private applyCadence(): void {
    const fast = this.subscribers.size > 0
    // The sidecar always delivers whatever it samples on its tick — the
    // interval alone is the rate limit. There is no separate on/off flag to
    // push here anymore (see native/resource-monitor's protocol v2 note).
    this.deps.client.setSampleInterval(fast ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS)
  }

  private ingest(raw: SidecarSnapshot): void {
    let result: BuildResult
    try {
      // getElectronMetrics() (app.getAppMetrics()) is one realistic throw source in
      // this path; getWindowDescriptors() and getConnectorCommands() below are two
      // more (a torn-down webContents, a malformed connector config). All of it runs
      // on the sidecar's stdout 'data' handler — uncaught, any of these would surface
      // as an unhandled main-process exception. A wedged sidecar or label source must
      // degrade the Diagnostics page, never the app, so keep whatever snapshot is
      // already published and let the next sample get a fresh try.
      // The sample's OWN timestamp, not this.now(): a registration must be aged
      // against when the scan was taken, never against when main got round to
      // ingesting it. See reconcile()'s doc comment — passing ingest time here
      // lets a sample that predates a pack app's spawn be the thing that deletes
      // its label. This is also the clock `startTimeMs` below is already on.
      const registered = this.deps.processLabels.reconcile(raw.processes, raw.sampledAtUnixMs)
      result = buildSnapshot({
        samples: raw.processes,
        previous: this.previous,
        previousPeakRssBytes: this.peakRssBytes,
        counters: this.counters,
        sampledAtMs: raw.sampledAtUnixMs,
        rootPid: this.deps.rootPid,
        cores: this.deps.cores,
        electronMetrics: this.deps.getElectronMetrics(),
        labelSources: {
          windows: this.deps.getWindowDescriptors(),
          connectors: this.deps.getConnectorCommands(),
          registered
        },
        liveOwners: new Set(this.deps.getLiveOwners()),
        busyOwners: new Set(this.deps.getBusyOwners())
      })
    } catch (err) {
      console.error('[diagnostics] failed to build snapshot from sidecar sample', err)
      return
    }

    this.previous = result.next
    this.peakRssBytes = result.footprint.peakRssBytes
    this.counters = result.counters

    // Captured once and reused for both the ring write and the published snapshot: two
    // separate this.now() calls straddling a bucket boundary would let record() and
    // current.readAt disagree about which 5s bucket "now" is, for one ingest() call in
    // roughly every BUCKET_MS worth of them.
    const nowMs = this.now()

    // Recorded from the SERVICE clock — the same one history() reads with. Using the
    // sidecar's sampledAtUnixMs here instead would put record and read on two clocks that
    // could disagree about which bucket "now" is, for no accuracy gained over the transit
    // time of one NDJSON line.
    this.ring.record({
      atMs: nowMs,
      cpuPercent: result.footprint.cpuPercent,
      rssBytes: result.footprint.rssBytes,
      processCount: result.footprint.processCount,
      objects: result.objects
    })

    this.current = {
      readAt: nowMs,
      sampleIntervalMs: this.subscribers.size > 0 ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS,
      cores: this.deps.cores,
      totalMemoryBytes: this.deps.totalMemoryBytes,
      footprint: result.footprint,
      objects: result.objects,
      tree: result.tree,
      sidecar: this.deps.client.health()
    }
    for (const l of this.listeners) l(this.current)
  }
}
