import type {
  DiagnosticsSnapshot,
  ElectronProcessMetric,
  SidecarHealth,
  SidecarSnapshot
} from '../../../shared/diagnostics'
import { buildSnapshot, type BuildResult, type ProcessState } from './model'

/** Page open: one sample a second. */
export const FAST_INTERVAL_MS = 1_000
/** Page closed: keep a low-rate heartbeat so history predates opening the page. */
export const SLOW_INTERVAL_MS = 15_000

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

  constructor(private readonly deps: DiagnosticsServiceDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  start(): void {
    if (this.unsubscribeClient) return
    this.unsubscribeClient = this.deps.client.onSnapshot((s) => this.ingest(s))
    this.unsubscribeHealth = this.deps.client.onHealthChange((h) => this.publishHealth(h))
    this.deps.client.start()
    this.applyCadence()
    // Publish immediately so latest() is never null after startup — including
    // when there is no working sidecar and no sample will ever arrive.
    this.publishHealth(this.deps.client.health())
  }

  stop(): void {
    this.unsubscribeClient?.()
    this.unsubscribeClient = null
    this.unsubscribeHealth?.()
    this.unsubscribeHealth = null
    this.deps.client.stop()
  }

  latest(): DiagnosticsSnapshot | null {
    return this.current
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
            exits: 0
          },
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
      // getElectronMetrics() (app.getAppMetrics()) is the one realistic throw source
      // in this path, and it runs on the sidecar's stdout 'data' handler — uncaught,
      // it would surface as an unhandled main-process exception. A wedged sidecar
      // must degrade the Diagnostics page, never the app, so keep whatever snapshot
      // is already published and let the next sample get a fresh try.
      result = buildSnapshot({
        samples: raw.processes,
        previous: this.previous,
        previousPeakRssBytes: this.peakRssBytes,
        counters: this.counters,
        sampledAtMs: raw.sampledAtUnixMs,
        rootPid: this.deps.rootPid,
        cores: this.deps.cores,
        electronMetrics: this.deps.getElectronMetrics()
      })
    } catch (err) {
      console.error('[diagnostics] failed to build snapshot from sidecar sample', err)
      return
    }

    this.previous = result.next
    this.peakRssBytes = result.footprint.peakRssBytes
    this.counters = result.counters

    this.current = {
      readAt: this.now(),
      sampleIntervalMs: this.subscribers.size > 0 ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS,
      cores: this.deps.cores,
      totalMemoryBytes: this.deps.totalMemoryBytes,
      footprint: result.footprint,
      tree: result.tree,
      sidecar: this.deps.client.health()
    }
    for (const l of this.listeners) l(this.current)
  }
}
