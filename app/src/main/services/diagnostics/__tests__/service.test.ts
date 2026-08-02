import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DiagnosticsService, FAST_INTERVAL_MS, SLOW_INTERVAL_MS } from '../index'
import type { SidecarClientLike } from '../index'
import type { SidecarSnapshot, DiagnosticsSnapshot } from '../../../../shared/diagnostics'

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
  emit(s: SidecarSnapshot): void
}

/** Minimal stand-in for SidecarClient — records what the service asked for. */
function fakeClient(): FakeClient {
  let cb: (s: SidecarSnapshot) => void = () => {}
  return {
    intervals: [] as number[],
    streaming: [] as boolean[],
    started: false,
    stopped: false,
    retried: 0,
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
    health: () => ({
      status: 'healthy' as const,
      version: '0.1.0',
      restartCount: 0,
      lastError: null
    }),
    onSnapshot(fn: (s: SidecarSnapshot) => void) {
      cb = fn
      return () => {}
    },
    emit(s: SidecarSnapshot) {
      cb(s)
    }
  }
}

function makeService(client = fakeClient()): { service: DiagnosticsService; client: FakeClient } {
  const service = new DiagnosticsService({
    client,
    rootPid: 1,
    cores: 4,
    totalMemoryBytes: 16_000,
    getElectronMetrics: () => [],
    now: () => 10_000
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
    const seen: DiagnosticsSnapshot[] = []
    service.onSnapshot((s) => seen.push(s))
    service.start()
    client.emit(snapshot())

    expect(seen).toHaveLength(1)
    expect(seen[0].footprint.rssBytes).toBe(500)
    expect(seen[0].cores).toBe(4)
    expect(seen[0].sidecar.status).toBe('healthy')
  })

  it('carries delta state across two snapshots', () => {
    const { service, client } = makeService()
    const seen: DiagnosticsSnapshot[] = []
    service.onSnapshot((s) => seen.push(s))
    service.start()

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
    expect(service.latest()).toBeNull()
    client.emit(snapshot())
    expect(service.latest()?.footprint.processCount).toBe(1)
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
})
