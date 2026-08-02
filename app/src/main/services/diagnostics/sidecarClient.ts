import {
  encodeSidecarCommand,
  parseSidecarEvent,
  type SidecarCommandInput,
  type SidecarHealth,
  type SidecarSnapshot,
  type SidecarStatus
} from '../../../shared/diagnostics'
import type { SidecarProcess, SidecarSpawner } from './spawner'

const HANDSHAKE_TIMEOUT_MS = 5_000
const FAILURE_WINDOW_MS = 60_000
const MAX_FAILURES_PER_WINDOW = 5
const MAX_BACKOFF_MS = 10_000

export type SidecarClientDeps = {
  spawner: SidecarSpawner
  binaryPath: string
  rootPid: number
  initialIntervalMs: number
}

/**
 * Owns the sidecar child: framing, handshake, and supervision.
 *
 * Failure policy: restart with exponential backoff, but if the child fails
 * MAX_FAILURES_PER_WINDOW times inside FAILURE_WINDOW_MS the circuit opens and
 * no further automatic restarts happen until retry() is called. A wedged
 * sidecar must degrade the Diagnostics page, never the app.
 */
export class SidecarClient {
  private proc: SidecarProcess | null = null
  private buffer = ''
  private handshakeDone = false
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private failures: number[] = []
  private attempt = 0
  private stopped = false
  private status: SidecarStatus = 'starting'
  private sidecarVersion: string | null = null
  private lastError: string | null = null
  private restartCount = 0
  private intervalMs: number
  private streaming = false
  private snapshotCbs: ((s: SidecarSnapshot) => void)[] = []

  constructor(private readonly deps: SidecarClientDeps) {
    this.intervalMs = deps.initialIntervalMs
  }

  onSnapshot(cb: (s: SidecarSnapshot) => void): () => void {
    this.snapshotCbs.push(cb)
    return () => {
      this.snapshotCbs = this.snapshotCbs.filter((c) => c !== cb)
    }
  }

  health(): SidecarHealth {
    return {
      status: this.status,
      version: this.sidecarVersion,
      restartCount: this.restartCount,
      lastError: this.lastError
    }
  }

  start(): void {
    this.stopped = false
    this.spawnOnce()
  }

  /** Close an open circuit and try again immediately. */
  retry(): void {
    // Always cancel the backoff: Retry means "stop waiting, try now".
    this.attempt = 0
    // Only wipe the failure window once the breaker has actually tripped.
    // Clearing it while merely degraded lets repeated clicks hold the circuit
    // open forever against a sidecar that is genuinely broken.
    if (this.status === 'unavailable') this.failures = []
    this.stopped = false
    // Return BEFORE touching timers. If an attempt is already in flight its 5s
    // handshake watchdog is armed, and clearing it here would leave a live child
    // permanently unwatched — a wedged sidecar would then never degrade.
    if (this.proc) return
    // Only reachable with no live child, so the only timer that can be pending is
    // the backoff restartTimer. Cancel it: `fail()` nulls this.proc before arming
    // it, so without this the timer spawns a second child after the one below and
    // orphans it — unreachable, never killed.
    this.clearTimers()
    this.spawnOnce()
  }

  stop(): void {
    this.stopped = true
    this.status = 'disabled'
    this.clearTimers()
    this.proc?.kill()
    this.proc = null
  }

  setSampleInterval(ms: number): void {
    this.intervalMs = ms
    this.send({ type: 'setSampleInterval', sampleIntervalMs: ms })
  }

  setStreaming(streaming: boolean): void {
    this.streaming = streaming
    this.send({ type: 'setStreaming', streaming })
  }

  sampleNow(requestId: string): void {
    this.send({ type: 'sampleNow', requestId })
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private clearTimers(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.handshakeTimer = null
    this.restartTimer = null
  }

  private send(cmd: SidecarCommandInput): void {
    if (!this.proc || !this.handshakeDone) return
    this.proc.writeLine(encodeSidecarCommand(cmd))
  }

  private spawnOnce(): void {
    if (this.stopped) return
    this.buffer = ''
    this.handshakeDone = false
    if (this.status !== 'degraded') this.status = 'starting'

    const proc = this.deps.spawner.spawn(this.deps.binaryPath)
    this.proc = proc

    this.handshakeTimer = setTimeout(() => {
      this.fail('handshake timed out after 5000ms')
    }, HANDSHAKE_TIMEOUT_MS)

    proc.onStdoutChunk((chunk) => {
      // A stale proc can still fire this after being superseded (killed, or
      // orphaned when the circuit opened) — the fake in tests, and a real
      // child that emits its last chunk while exiting, both do this. Without
      // the identity check a stray 'hello' can resurrect a dead attempt.
      if (this.proc !== proc) return
      this.ingest(chunk)
    })
    proc.onStderr(() => {})
    proc.onExit((code) => {
      if (this.stopped || this.proc !== proc) return
      this.fail(`sidecar exited with code ${code ?? 'null'}`)
    })
  }

  private ingest(chunk: string): void {
    this.buffer += chunk
    let idx = this.buffer.indexOf('\n')
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      this.handleLine(line)
      idx = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    const ev = parseSidecarEvent(line)
    if (!ev) return

    if (ev.type === 'hello') {
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
      this.handshakeDone = true
      this.status = 'healthy'
      this.lastError = null
      this.attempt = 0
      this.sidecarVersion = ev.sidecarVersion
      this.proc?.writeLine(
        encodeSidecarCommand({
          type: 'configure',
          rootPid: this.deps.rootPid,
          sampleIntervalMs: this.intervalMs,
          streaming: this.streaming
        })
      )
      return
    }

    if (ev.type === 'error') {
      this.lastError = ev.message
      return
    }

    // A snapshot before the handshake means a rogue or mismatched binary.
    if (!this.handshakeDone) return
    for (const cb of this.snapshotCbs) cb(ev)
  }

  private fail(reason: string): void {
    if (this.stopped) return
    this.clearTimers()
    // Null this.proc BEFORE kill(): a fake (or fast-exiting real) child can
    // invoke its exit callback synchronously from within kill(). The onExit
    // handler's `this.proc !== proc` guard only blocks re-entrant fail() calls
    // if this.proc is already cleared by the time that callback fires.
    const dying = this.proc
    this.proc = null
    dying?.kill()
    this.lastError = reason
    this.restartCount += 1

    const now = Date.now()
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS)
    this.failures.push(now)

    if (this.failures.length >= MAX_FAILURES_PER_WINDOW) {
      this.status = 'unavailable'
      return
    }

    this.status = 'degraded'
    const delay = Math.min(500 * 2 ** this.attempt, MAX_BACKOFF_MS)
    this.attempt += 1
    this.restartTimer = setTimeout(() => this.spawnOnce(), delay)
  }
}
