import type {
  DiagnosticsSnapshot,
  ElectronProcessMetric,
  SidecarHealth,
  SidecarSnapshot
} from '../../../shared/diagnostics'
import { buildSnapshot, type ProcessState } from './model'

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
  setStreaming(streaming: boolean): void
  sampleNow(requestId: string): void
  health(): SidecarHealth
  onSnapshot(cb: (s: SidecarSnapshot) => void): () => void
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

  constructor(private readonly deps: DiagnosticsServiceDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  start(): void {
    this.unsubscribeClient = this.deps.client.onSnapshot((s) => this.ingest(s))
    this.deps.client.start()
    this.applyCadence()
  }

  stop(): void {
    this.unsubscribeClient?.()
    this.unsubscribeClient = null
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

  private applyCadence(): void {
    const fast = this.subscribers.size > 0
    this.deps.client.setSampleInterval(fast ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS)
    this.deps.client.setStreaming(fast)
  }

  private ingest(raw: SidecarSnapshot): void {
    const result = buildSnapshot({
      samples: raw.processes,
      previous: this.previous,
      previousPeakRssBytes: this.peakRssBytes,
      counters: this.counters,
      sampledAtMs: raw.sampledAtUnixMs,
      rootPid: this.deps.rootPid,
      cores: this.deps.cores,
      electronMetrics: this.deps.getElectronMetrics()
    })

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
