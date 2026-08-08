/* eslint-disable @typescript-eslint/no-empty-function -- FakeProcess stubs
 * SidecarProcess's onStderr intentionally with an empty body. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DiagnosticsService, SLOW_INTERVAL_MS } from '../index'
import { SidecarClient } from '../sidecarClient'
import { ProcessLabels } from '../processLabels'
import type { SidecarProcess, SidecarSpawner } from '../spawner'
import type { DiagnosticsObject, ProcessSample } from '../../../../shared/diagnostics'

/**
 * These tests wire the REAL SidecarClient into DiagnosticsService over a fake
 * child, rather than the hand-written fake client service.test.ts uses.
 *
 * That is the whole point: the fake client's sampleNow() always "succeeds", so
 * it structurally cannot express the thing under test — SidecarClient.send() is
 * a no-op without a live, handshaken child, so an on-register sampleNow fired
 * during sidecar startup or restart backoff is dropped on the floor. The defect
 * lives in the composition of the two modules, not inside either one.
 */

const ROOT_PID = 1
const PACK_PID = 4242

class FakeProcess implements SidecarProcess {
  readonly pid = 999
  lines: string[] = []
  killed = false
  private stdoutCb: (c: string) => void = () => {}
  private exitCb: (code: number | null) => void = () => {}
  writeLine(line: string): void {
    this.lines.push(line.trim())
  }
  onStdoutChunk(cb: (c: string) => void): void {
    this.stdoutCb = cb
  }
  onStderr(): void {}
  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb
  }
  kill(): void {
    this.killed = true
    this.exitCb(0)
  }
  emit(chunk: string): void {
    this.stdoutCb(chunk)
  }
  /** Commands of the given type this child actually received. */
  commands(type: string): unknown[] {
    return this.lines.map((l) => JSON.parse(l)).filter((c) => c.type === type)
  }
}

function hello(): string {
  return JSON.stringify({ version: 2, type: 'hello', sidecarVersion: '0.1.0', pid: 999 }) + '\n'
}

function proc(pid: number, startTimeMs: number, name: string): ProcessSample {
  return {
    pid,
    ppid: pid === ROOT_PID ? 0 : ROOT_PID,
    startTimeMs,
    runTimeMs: 1_000,
    name,
    command: name,
    status: 'Run',
    cpuTimeMs: 0,
    residentBytes: 1_000
  }
}

function snapshotLine(
  sequence: number,
  sampledAtUnixMs: number,
  processes: ProcessSample[]
): string {
  return (
    JSON.stringify({
      version: 2,
      type: 'snapshot',
      sequence,
      sampledAtUnixMs,
      collectionDurationMicros: 10,
      scannedProcessCount: 400,
      retainedProcessCount: processes.length,
      processes
    }) + '\n'
  )
}

type Harness = {
  procs: FakeProcess[]
  client: SidecarClient
  labels: ProcessLabels
  service: DiagnosticsService
  setClock: (ms: number) => void
  /** Open a pack app at `atMs`: exactly what ExternalAppHost.open() records. */
  openPackApp: (atMs: number) => void
  packRow: () => DiagnosticsObject | undefined
}

function harness(): Harness {
  const procs: FakeProcess[] = []
  const spawner: SidecarSpawner = {
    spawn: () => {
      const p = new FakeProcess()
      procs.push(p)
      return p
    }
  }
  const client = new SidecarClient({
    spawner,
    binaryPath: 'C:/fake/argus-resource-monitor.exe',
    rootPid: ROOT_PID,
    initialIntervalMs: SLOW_INTERVAL_MS
  })
  const labels = new ProcessLabels()
  let clock = 1_000
  const service = new DiagnosticsService({
    client,
    rootPid: ROOT_PID,
    cores: 4,
    totalMemoryBytes: 16_000,
    getElectronMetrics: () => [],
    getWindowDescriptors: () => [],
    getConnectorCommands: () => [],
    processLabels: labels,
    // The pack app's case is open, so the row is owned, not orphaned.
    getLiveOwners: () => ['CASE-A'],
    now: () => clock
  })
  return {
    procs,
    client,
    labels,
    service,
    setClock: (ms: number) => {
      clock = ms
    },
    /** Open a pack app: exactly what ExternalAppHost.open() records. */
    openPackApp: (atMs: number) => {
      clock = atMs
      labels.register(
        PACK_PID,
        { kind: 'pack-app', label: 'Pack app: sample-external-app/console', owner: 'CASE-A' },
        atMs
      )
    },
    packRow: () => service.latest()?.objects.find((o) => o.rootPid === PACK_PID)
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('a tier-A registration made while the sidecar is still starting', () => {
  it('has its on-register sampleNow dropped on the floor', () => {
    const h = harness()
    h.service.start()

    // Boot: the child is spawned but has not said hello yet, so send() no-ops.
    h.openPackApp(3_000)

    expect(h.procs[0].commands('sampleNow')).toHaveLength(0)
  })

  it('is still labelled once the sidecar recovers and delivers a sample', async () => {
    const h = harness()
    h.service.start()
    h.openPackApp(3_000)

    // The handshake never completes: watchdog fires at 5s, the client fails the
    // attempt and respawns after its 500ms backoff. By the time the replacement
    // child says hello, far more than PIN_TOLERANCE_MS has elapsed since the
    // registration.
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(500)
    expect(h.procs).toHaveLength(2)

    h.setClock(9_500)
    h.procs[1].emit(hello())
    await vi.advanceTimersByTimeAsync(0)

    // The health transition into 'healthy' fires the resync sample...
    expect(h.procs[1].commands('sampleNow')).toHaveLength(1)

    // ...and the sidecar answers with a sample that contains the still-running
    // pack app.
    h.procs[1].emit(
      snapshotLine(1, 9_400, [proc(ROOT_PID, 0, 'argus'), proc(PACK_PID, 3_000, 'pack-app')])
    )

    expect(h.packRow()).toMatchObject({
      kind: 'pack-app',
      label: 'Pack app: sample-external-app/console'
    })
  })

  it('is not destroyed by a stale sample taken before the pack app was spawned', async () => {
    // The boot-time shape. The sidecar handshakes early and immediately emits
    // its first sample (configure sets next_sample_at = now), but main is busy
    // finishing boot — window creation, DB open, pack registry load — so that
    // sample sits in the event queue. The pack app is opened while it waits.
    //
    // When main finally drains the queue, reconcile() ages the registration
    // against the INGEST wall clock rather than against the time the sample was
    // actually taken. The sample predates the pack app's existence and could
    // never have contained it, yet it is what sweeps the entry — permanently,
    // since an unpinned entry gets exactly one chance.
    const h = harness()
    h.service.start()
    h.setClock(1_000)
    h.procs[0].emit(hello())
    await vi.advanceTimersByTimeAsync(0)

    h.openPackApp(3_000)

    // Ingested at 9_000, but sampled at 1_100 — before PACK_PID existed.
    h.setClock(9_000)
    h.procs[0].emit(snapshotLine(1, 1_100, [proc(ROOT_PID, 0, 'argus')]))

    // The next real sample has the pack app, which is still running.
    h.setClock(9_100)
    h.procs[0].emit(
      snapshotLine(2, 9_050, [proc(ROOT_PID, 0, 'argus'), proc(PACK_PID, 3_000, 'pack-app')])
    )

    expect(h.packRow()).toMatchObject({
      kind: 'pack-app',
      label: 'Pack app: sample-external-app/console'
    })
  })

  it('still ages out a registration whose process never appears', async () => {
    // The GC path the tolerance exists for must survive the fix: a spawn that
    // failed, or a process that exited before it was ever sampled, must not
    // hold its slot forever.
    const h = harness()
    h.service.start()
    h.procs[0].emit(hello())
    await vi.advanceTimersByTimeAsync(0)

    h.openPackApp(3_000)

    // A sample taken well after the registration, with no such pid in it.
    h.setClock(20_000)
    h.procs[0].emit(snapshotLine(1, 20_000, [proc(ROOT_PID, 0, 'argus')]))

    // Even if that pid is later reused by an unrelated process, it must not
    // inherit the pack app's label.
    h.setClock(35_000)
    h.procs[0].emit(
      snapshotLine(2, 35_000, [
        proc(ROOT_PID, 0, 'argus'),
        proc(PACK_PID, 34_000, 'something-else')
      ])
    )

    expect(h.packRow()).toBeUndefined()
    expect(h.labels.pinnedCount()).toBe(0)
  })
})
