/* eslint-disable @typescript-eslint/no-empty-function -- FakeProcess below stubs
 * SidecarProcess's onStderr intentionally with an empty body. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SidecarClient, createDisabledSidecarClient } from '../sidecarClient'
import type { SidecarProcess, SidecarSpawner } from '../spawner'
import type { SidecarHealth, SidecarSnapshot } from '../../../../shared/diagnostics'

/** A controllable fake child. Tests drive stdout and exit by hand. */
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
  die(code: number | null = 1): void {
    this.exitCb(code)
  }
}

function hello(): string {
  return JSON.stringify({ version: 2, type: 'hello', sidecarVersion: '0.1.0', pid: 999 }) + '\n'
}

function snapshot(sequence: number): string {
  return (
    JSON.stringify({
      version: 2,
      type: 'snapshot',
      sequence,
      sampledAtUnixMs: 1000,
      collectionDurationMicros: 10,
      scannedProcessCount: 400,
      retainedProcessCount: 1,
      processes: []
    }) + '\n'
  )
}

function makeClient(): { client: SidecarClient; procs: FakeProcess[] } {
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
    rootPid: 42,
    initialIntervalMs: 15_000
  })
  return { client, procs }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SidecarClient', () => {
  it('configures with the root pid once the handshake completes', async () => {
    const { client, procs } = makeClient()
    void client.start()
    procs[0].emit(hello())
    await vi.advanceTimersByTimeAsync(0)

    const configure = procs[0].lines.map((l) => JSON.parse(l)).find((c) => c.type === 'configure')
    expect(configure).toMatchObject({ version: 2, rootPid: 42, sampleIntervalMs: 15_000 })
    expect(configure).not.toHaveProperty('streaming')
    expect(client.health().status).toBe('healthy')
    expect(client.health().version).toBe('0.1.0')
  })

  it('reassembles a snapshot split across chunk boundaries', async () => {
    const { client, procs } = makeClient()
    const seen: SidecarSnapshot[] = []
    client.onSnapshot((s) => seen.push(s))
    void client.start()
    procs[0].emit(hello())
    await vi.advanceTimersByTimeAsync(0)

    const line = snapshot(1)
    procs[0].emit(line.slice(0, 20))
    expect(seen).toHaveLength(0)
    procs[0].emit(line.slice(20))
    expect(seen).toHaveLength(1)
    expect(seen[0].sequence).toBe(1)
  })

  it('handles two snapshots arriving in one chunk', async () => {
    const { client, procs } = makeClient()
    const seen: SidecarSnapshot[] = []
    client.onSnapshot((s) => seen.push(s))
    void client.start()
    procs[0].emit(hello())
    await vi.advanceTimersByTimeAsync(0)

    procs[0].emit(snapshot(1) + snapshot(2))
    expect(seen.map((s) => s.sequence)).toEqual([1, 2])
  })

  it('fails the attempt when the handshake times out', async () => {
    const { client } = makeClient()
    void client.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(client.health().status).toBe('degraded')
    expect(client.health().lastError).toContain('handshake')
  })

  it('restarts with backoff after an unexpected exit', async () => {
    const { client, procs } = makeClient()
    void client.start()
    procs[0].emit(hello())
    await vi.advanceTimersByTimeAsync(0)
    expect(procs).toHaveLength(1)

    procs[0].die(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(procs).toHaveLength(2)
    expect(client.health().restartCount).toBe(1)
  })

  it('opens the circuit after five failures inside the window', async () => {
    const { client, procs } = makeClient()
    void client.start()
    for (let i = 0; i < 5; i++) {
      procs[procs.length - 1].emit(hello())
      await vi.advanceTimersByTimeAsync(0)
      procs[procs.length - 1].die(1)
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(client.health().status).toBe('unavailable')
    const spawnedSoFar = procs.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(procs).toHaveLength(spawnedSoFar)
  })

  it('a manual retry closes an open circuit', async () => {
    const { client, procs } = makeClient()
    void client.start()
    for (let i = 0; i < 5; i++) {
      procs[procs.length - 1].emit(hello())
      await vi.advanceTimersByTimeAsync(0)
      procs[procs.length - 1].die(1)
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(client.health().status).toBe('unavailable')

    void client.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(procs.length).toBeGreaterThan(5)
    procs[procs.length - 1].emit(hello())
    await vi.advanceTimersByTimeAsync(0)
    expect(client.health().status).toBe('healthy')
  })

  it('a flapping sidecar still opens the circuit even if Retry is clicked while merely degraded', async () => {
    const { client, procs } = makeClient()
    void client.start()
    // Each cycle: complete a handshake, kill the child, then (unless the
    // circuit just tripped) click Retry while status is still 'degraded'.
    // Before the fix, retry() unconditionally cleared this.failures, so the
    // failure count reset every cycle and the circuit could never reach
    // MAX_FAILURES_PER_WINDOW no matter how many times the sidecar died.
    for (let i = 0; i < 5; i++) {
      procs[procs.length - 1].emit(hello())
      await vi.advanceTimersByTimeAsync(0)
      procs[procs.length - 1].die(1)
      if (client.health().status === 'degraded') {
        void client.retry()
        await vi.advanceTimersByTimeAsync(0)
      }
    }
    expect(client.health().status).toBe('unavailable')
  })

  it('retry() during a pending backoff does not orphan a second child', async () => {
    const { client, procs } = makeClient()
    void client.start()
    procs[0].emit(hello())
    await vi.advanceTimersByTimeAsync(0)

    // Trigger a failure so fail() nulls this.proc and schedules a backoff
    // restartTimer, without letting that timer fire yet.
    procs[0].die(1)
    expect(procs).toHaveLength(1)

    // A user clicks Retry while the backoff window is still open. Before the
    // fix, retry()'s `if (this.proc) return` guard didn't catch this (proc is
    // null here), so it spawned proc B and left the original restartTimer
    // pending, which later spawned proc C and orphaned proc B.
    const countBeforeRetry = procs.length
    void client.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(procs).toHaveLength(countBeforeRetry + 1)

    // Complete the handshake for the new child so it doesn't independently
    // time out and start its own fresh failure/backoff cycle — we only want
    // to observe whether the stale restartTimer from the ORIGINAL backoff
    // window (the one retry() must cancel) fires and spawns again.
    procs[procs.length - 1].emit(hello())
    await vi.advanceTimersByTimeAsync(0)

    // Advance well past the original backoff delay (500ms). If the stale
    // restartTimer was never cancelled, it fires here and spawns an extra,
    // orphaned child.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(procs).toHaveLength(countBeforeRetry + 1)
  })

  it('retry() during an in-flight spawn leaves the handshake watchdog armed', async () => {
    const { client, procs } = makeClient()
    void client.start()
    // Do NOT emit hello: the spawn is in flight with its 5000ms handshake
    // timer armed and this.proc set.

    // A user clicks Retry again while that attempt is still pending. Before
    // the fix, retry()'s clearTimers() ran before the `if (this.proc) return`
    // guard, cancelling the live child's handshake watchdog and then
    // returning without arming a replacement — leaving the child unwatched
    // forever if it never sends hello.
    void client.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(procs).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(client.health().status).toBe('degraded')
    expect(client.health().lastError).toContain('handshake')
  })

  it('stop() kills the child and does not restart it', async () => {
    const { client, procs } = makeClient()
    void client.start()
    procs[0].emit(hello())
    await vi.advanceTimersByTimeAsync(0)

    client.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(procs[0].killed).toBe(true)
    expect(procs).toHaveLength(1)
    expect(client.health().status).toBe('disabled')
  })

  it('retry() after stop() does not resurrect the client', async () => {
    const { client, procs } = makeClient()
    void client.start()
    procs[0].emit(hello())
    await vi.advanceTimersByTimeAsync(0)

    client.stop()
    expect(client.health().status).toBe('disabled')

    // A retrySidecar() IPC can arrive after stop() — quit in flight, or a stale
    // renderer whose Retry button is still wired. Before the fix, retry() set
    // this.stopped = false unconditionally and spawned a fresh child.
    void client.retry()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(procs).toHaveLength(1)
    expect(client.health().status).toBe('disabled')
  })

  it('drops an unbounded buffer and routes it through the failure path', async () => {
    const { client, procs } = makeClient()
    const seen: SidecarHealth[] = []
    client.onHealthChange((h) => seen.push(h))
    void client.start()
    procs[0].emit(hello())
    await vi.advanceTimersByTimeAsync(0)

    // A binary substituted via ARGUS_RESOURCE_MONITOR_PATH could emit a very long
    // line with no newline. The real sidecar never does this — one NDJSON line per
    // snapshot — so this only guards against a misbehaving substitute.
    procs[0].emit('x'.repeat(1_000_001))

    expect(seen.at(-1)?.status).toBe('degraded')
    expect(seen.at(-1)?.lastError).toContain('1000001 bytes')
    // The dying child is killed as part of the existing failure path, then a
    // replacement is spawned on backoff, same as any other fail().
    await vi.advanceTimersByTimeAsync(500)
    expect(procs).toHaveLength(2)
  })

  it('ignores a snapshot that arrives before the handshake', async () => {
    const { client, procs } = makeClient()
    const seen: SidecarSnapshot[] = []
    client.onSnapshot((s) => seen.push(s))
    void client.start()
    procs[0].emit(snapshot(1))
    expect(seen).toHaveLength(0)
  })

  describe('onHealthChange', () => {
    it('notifies when the handshake completes', async () => {
      const { client, procs } = makeClient()
      const seen: SidecarHealth[] = []
      client.onHealthChange((h) => seen.push(h))
      void client.start()
      // spawnOnce() fires once for the 'starting' transition before hello arrives.
      expect(seen.at(-1)?.status).toBe('starting')

      procs[0].emit(hello())
      await vi.advanceTimersByTimeAsync(0)

      expect(seen.at(-1)?.status).toBe('healthy')
      expect(seen.at(-1)?.version).toBe('0.1.0')
    })

    it('notifies when the handshake times out', async () => {
      const { client } = makeClient()
      const seen: SidecarHealth[] = []
      client.onHealthChange((h) => seen.push(h))
      void client.start()

      await vi.advanceTimersByTimeAsync(5_000)

      expect(seen.at(-1)?.status).toBe('degraded')
      expect(seen.at(-1)?.lastError).toContain('handshake')
    })

    it('notifies when the circuit opens after repeated failures', async () => {
      const { client, procs } = makeClient()
      const seen: SidecarHealth[] = []
      client.onHealthChange((h) => seen.push(h))
      void client.start()
      for (let i = 0; i < 5; i++) {
        procs[procs.length - 1].emit(hello())
        await vi.advanceTimersByTimeAsync(0)
        procs[procs.length - 1].die(1)
        await vi.advanceTimersByTimeAsync(10_000)
      }

      expect(seen.at(-1)?.status).toBe('unavailable')
    })

    it('notifies when stop() disables the client', async () => {
      const { client, procs } = makeClient()
      const seen: SidecarHealth[] = []
      client.onHealthChange((h) => seen.push(h))
      void client.start()
      procs[0].emit(hello())
      await vi.advanceTimersByTimeAsync(0)

      client.stop()

      expect(seen.at(-1)?.status).toBe('disabled')
    })

    it('stops notifying once unsubscribed', async () => {
      const { client, procs } = makeClient()
      const seen: SidecarHealth[] = []
      const off = client.onHealthChange((h) => seen.push(h))
      void client.start()
      off()

      procs[0].emit(hello())
      await vi.advanceTimersByTimeAsync(0)

      expect(seen.some((h) => h.status === 'healthy')).toBe(false)
    })
  })
})

describe('createDisabledSidecarClient', () => {
  it('reports a disabled status with the given reason and never calls back', () => {
    const client = createDisabledSidecarClient('no sidecar binary for this platform')
    expect(client.health()).toEqual({
      status: 'disabled',
      version: null,
      restartCount: 0,
      lastError: 'no sidecar binary for this platform'
    })

    const snapshotCbs: unknown[] = []
    const healthCbs: unknown[] = []
    const offSnapshot = client.onSnapshot((s) => snapshotCbs.push(s))
    const offHealth = client.onHealthChange((h) => healthCbs.push(h))

    // All mutators are no-ops: none of them should throw, and none should
    // ever invoke a subscriber (there is no sidecar producing events).
    client.start()
    client.stop()
    client.retry()
    client.setSampleInterval(1_000)
    client.sampleNow('req-1')
    offSnapshot()
    offHealth()

    expect(snapshotCbs).toHaveLength(0)
    expect(healthCbs).toHaveLength(0)
    expect(client.health().status).toBe('disabled')
  })
})
