import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DiagnosticsService, FAST_INTERVAL_MS, SLOW_INTERVAL_MS } from '../index'
import type { SidecarClientLike, DiagnosticsServiceDeps } from '../index'
import { createDisabledSidecarClient } from '../sidecarClient'
import type {
  SidecarSnapshot,
  DiagnosticsSnapshot,
  SidecarHealth
} from '../../../../shared/diagnostics'

function snapshot(over: Partial<SidecarSnapshot> = {}): SidecarSnapshot {
  return {
    version: 1,
    type: 'snapshot',
    sequence: 1,
    sampledAtUnixMs: 10_000,
    collectionDurationMicros: 100,
    scannedProcessCount: 400,
    retainedProcessCount: 1,
    processes: [
      {
        pid: 1,
        ppid: 0,
        startTimeMs: 1_000,
        runTimeMs: 9_000,
        name: 'argus',
        command: 'argus',
        status: 'Run',
        cpuTimeMs: 0,
        residentBytes: 500
      }
    ],
    ...over
  }
}

type FakeClient = SidecarClientLike & {
  intervals: number[]
  streaming: boolean[]
  started: boolean
  stopped: boolean
  retried: number
  listenerCount: number
  unsubscribeCalls: number
  healthListenerCount: number
  emit(s: SidecarSnapshot): void
  emitHealth(h: SidecarHealth): void
}

/** Minimal stand-in for SidecarClient — records what the service asked for. */
function fakeClient(): FakeClient {
  const callbacks: ((s: SidecarSnapshot) => void)[] = []
  const healthCallbacks: ((h: SidecarHealth) => void)[] = []
  let currentHealth: SidecarHealth = {
    status: 'healthy',
    version: '0.1.0',
    restartCount: 0,
    lastError: null
  }
  return {
    intervals: [] as number[],
    streaming: [] as boolean[],
    started: false,
    stopped: false,
    retried: 0,
    listenerCount: 0,
    unsubscribeCalls: 0,
    healthListenerCount: 0,
    start() {
      this.started = true
    },
    stop() {
      this.stopped = true
    },
    retry() {
      this.retried += 1
    },
    setSampleInterval(ms: number) {
      this.intervals.push(ms)
    },
    setStreaming(s: boolean) {
      this.streaming.push(s)
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- unused by these tests
    sampleNow() {},
    health: () => currentHealth,
    onSnapshot(fn: (s: SidecarSnapshot) => void) {
      callbacks.push(fn)
      this.listenerCount += 1
      let unsubscribed = false
      return () => {
        if (unsubscribed) return
        unsubscribed = true
        this.unsubscribeCalls += 1
        this.listenerCount -= 1
        const idx = callbacks.indexOf(fn)
        if (idx >= 0) callbacks.splice(idx, 1)
      }
    },
    onHealthChange(fn: (h: SidecarHealth) => void) {
      healthCallbacks.push(fn)
      this.healthListenerCount += 1
      let unsubscribed = false
      return () => {
        if (unsubscribed) return
        unsubscribed = true
        this.healthListenerCount -= 1
        const idx = healthCallbacks.indexOf(fn)
        if (idx >= 0) healthCallbacks.splice(idx, 1)
      }
    },
    emit(s: SidecarSnapshot) {
      for (const cb of callbacks) cb(s)
    },
    emitHealth(h: SidecarHealth) {
      currentHealth = h
      for (const cb of healthCallbacks) cb(h)
    }
  }
}

function makeService(
  client = fakeClient(),
  overrides: Partial<Omit<DiagnosticsServiceDeps, 'client'>> = {}
): { service: DiagnosticsService; client: FakeClient } {
  const service = new DiagnosticsService({
    client,
    rootPid: 1,
    cores: 4,
    totalMemoryBytes: 16_000,
    getElectronMetrics: () => [],
    now: () => 10_000,
    ...overrides
  })
  return { service, client }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DiagnosticsService', () => {
  it('starts the sidecar at the slow interval with streaming off', () => {
    const { service, client } = makeService()
    service.start()
    expect(client.started).toBe(true)
    expect(client.intervals.at(-1)).toBe(SLOW_INTERVAL_MS)
    expect(client.streaming.at(-1)).toBe(false)
  })

  it('switches to the fast interval and turns streaming on for the first subscriber', () => {
    const { service, client } = makeService()
    service.start()
    service.subscribe(1)
    expect(client.intervals.at(-1)).toBe(FAST_INTERVAL_MS)
    expect(client.streaming.at(-1)).toBe(true)
  })

  it('stays fast while a second window is still subscribed', () => {
    const { service, client } = makeService()
    service.start()
    service.subscribe(1)
    service.subscribe(2)
    service.unsubscribe(1)
    expect(client.intervals.at(-1)).toBe(FAST_INTERVAL_MS)
    expect(client.streaming.at(-1)).toBe(true)
  })

  it('returns to the slow interval when the last subscriber leaves', () => {
    const { service, client } = makeService()
    service.start()
    service.subscribe(1)
    service.unsubscribe(1)
    expect(client.intervals.at(-1)).toBe(SLOW_INTERVAL_MS)
    expect(client.streaming.at(-1)).toBe(false)
  })

  it('is idempotent for a repeated subscribe from the same window', () => {
    const { service, client } = makeService()
    service.start()
    service.subscribe(1)
    service.subscribe(1)
    service.unsubscribe(1)
    expect(client.streaming.at(-1)).toBe(false)
  })

  it('publishes a built snapshot to listeners', () => {
    const { service, client } = makeService()
    service.start()
    // Registered after start() so it doesn't also catch the startup health publish.
    const seen: DiagnosticsSnapshot[] = []
    service.onSnapshot((s) => seen.push(s))
    client.emit(snapshot())

    expect(seen).toHaveLength(1)
    expect(seen[0].footprint.rssBytes).toBe(500)
    expect(seen[0].cores).toBe(4)
    expect(seen[0].sidecar.status).toBe('healthy')
  })

  it('carries delta state across two snapshots', () => {
    const { service, client } = makeService()
    service.start()
    const seen: DiagnosticsSnapshot[] = []
    service.onSnapshot((s) => seen.push(s))

    client.emit(snapshot({ sampledAtUnixMs: 10_000 }))
    client.emit(
      snapshot({
        sequence: 2,
        sampledAtUnixMs: 11_000,
        processes: [{ ...snapshot().processes[0], cpuTimeMs: 1_000 }]
      })
    )
    // One full core over one second, on four cores.
    expect(seen[1].footprint.cpuPercent).toBeCloseTo(25, 5)
  })

  it('exposes the most recent snapshot via latest()', () => {
    const { service, client } = makeService()
    service.start()
    // start() publishes immediately so latest() is never null after startup —
    // an empty tree/footprint carrying the client's current health, not a real
    // sample yet.
    expect(service.latest()).not.toBeNull()
    expect(service.latest()?.tree).toEqual([])
    client.emit(snapshot())
    expect(service.latest()?.footprint.processCount).toBe(1)
  })

  it('publishes once on start() so latest() is never null, even with no sidecar at all', () => {
    const client = createDisabledSidecarClient('no sidecar binary for this platform')
    const service = new DiagnosticsService({
      client,
      rootPid: 1,
      cores: 4,
      totalMemoryBytes: 16_000,
      getElectronMetrics: () => [],
      now: () => 10_000
    })
    service.start()
    expect(service.latest()?.sidecar.status).toBe('disabled')
    expect(service.latest()?.sidecar.lastError).toBe('no sidecar binary for this platform')
    expect(service.latest()?.tree).toEqual([])
    expect(service.latest()?.cores).toBe(4)
    expect(service.latest()?.totalMemoryBytes).toBe(16_000)
  })

  it('republishes an empty snapshot with fresh health when the sidecar becomes unavailable before any sample arrives', () => {
    const { service, client } = makeService()
    const seen: DiagnosticsSnapshot[] = []
    service.start()
    service.onSnapshot((s) => seen.push(s))

    client.emitHealth({
      status: 'unavailable',
      version: null,
      restartCount: 5,
      lastError: 'sidecar exited with code 1'
    })

    expect(seen).toHaveLength(1)
    expect(seen[0].sidecar.status).toBe('unavailable')
    expect(seen[0].sidecar.lastError).toBe('sidecar exited with code 1')
    expect(seen[0].tree).toEqual([])
  })

  it('republishes the last real snapshot with fresh sidecar health after a sample has arrived', () => {
    const { service, client } = makeService()
    service.start()
    client.emit(snapshot())

    const seen: DiagnosticsSnapshot[] = []
    service.onSnapshot((s) => seen.push(s))
    client.emitHealth({
      status: 'degraded',
      version: '0.1.0',
      restartCount: 1,
      lastError: 'sidecar exited with code 1'
    })

    expect(seen).toHaveLength(1)
    expect(seen[0].sidecar.status).toBe('degraded')
    // The prior sample's tree/footprint survive — only sidecar health refreshed.
    expect(seen[0].tree).toHaveLength(1)
    expect(seen[0].footprint.processCount).toBe(1)
  })

  it('stops republishing health changes after stop()', () => {
    const { service, client } = makeService()
    service.start()
    service.stop()

    const seen: DiagnosticsSnapshot[] = []
    service.onSnapshot((s) => seen.push(s))
    client.emitHealth({ status: 'unavailable', version: null, restartCount: 1, lastError: 'x' })

    expect(seen).toHaveLength(0)
    expect(client.healthListenerCount).toBe(0)
  })

  it('forwards a retry to the client', () => {
    const { service, client } = makeService()
    service.start()
    service.retrySidecar()
    expect(client.retried).toBe(1)
  })

  it('stop() stops the client', () => {
    const { service, client } = makeService()
    service.start()
    service.stop()
    expect(client.stopped).toBe(true)
  })

  it('is idempotent for a repeated start(): only one listener stays registered', () => {
    const { service, client } = makeService()
    service.start()
    service.start()
    expect(client.listenerCount).toBe(1)

    // A single real snapshot must only ever be ingested once — a leaked second
    // listener would double-ingest and corrupt the CPU delta.
    const seen: DiagnosticsSnapshot[] = []
    service.onSnapshot((s) => seen.push(s))
    client.emit(snapshot({ sampledAtUnixMs: 10_000 }))
    client.emit(
      snapshot({
        sequence: 2,
        sampledAtUnixMs: 11_000,
        processes: [{ ...snapshot().processes[0], cpuTimeMs: 1_000 }]
      })
    )
    expect(seen).toHaveLength(2)
    expect(seen[1].footprint.cpuPercent).toBeCloseTo(25, 5)

    // stop() → start() must still register exactly one fresh listener.
    service.stop()
    service.start()
    expect(client.listenerCount).toBe(1)
    expect(client.unsubscribeCalls).toBe(1)
  })

  it('roots the tree at deps.rootPid, never the lowest sampled pid', () => {
    // Pid 7 is a child of pid 50 but numerically lower than it — the
    // post-wraparound case the invariant guards against. A rootPid inferred as
    // Math.min(...pids) would pick 7 and invert the whole tree.
    const { service, client } = makeService(fakeClient(), { rootPid: 50 })
    service.start()
    const seen: DiagnosticsSnapshot[] = []
    service.onSnapshot((s) => seen.push(s))

    client.emit(
      snapshot({
        processes: [
          {
            pid: 50,
            ppid: 0,
            startTimeMs: 1_000,
            runTimeMs: 9_000,
            name: 'argus',
            command: 'argus',
            status: 'Run',
            cpuTimeMs: 0,
            residentBytes: 500
          },
          {
            pid: 7,
            ppid: 50,
            startTimeMs: 2_000,
            runTimeMs: 5_000,
            name: 'child',
            command: 'child',
            status: 'Run',
            cpuTimeMs: 0,
            residentBytes: 200
          }
        ]
      })
    )

    const tree = seen[0].tree
    const root = tree.find((p) => p.pid === 50)
    const child = tree.find((p) => p.pid === 7)
    expect(root?.depth).toBe(0)
    expect(child?.depth).toBe(1)
  })
})
