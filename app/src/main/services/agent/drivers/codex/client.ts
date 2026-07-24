import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'

/**
 * Thin JSON-RPC-shaped stdio transport for `codex app-server`. Deliberately
 * protocol-method-agnostic — it frames/parses JSONL, correlates request↔response by
 * `id`, routes id-less inbound messages to a notification callback, and routes
 * id-bearing inbound `method` messages (server-initiated requests, e.g. approvals)
 * to a server-request callback. It does not know any Codex method names; those are
 * owned by the drivers built on top of this client.
 *
 * Wire facts (verified against t3code's `effect-codex-app-server/src/protocol.ts`,
 * not the plan's placeholder examples): newline-delimited JSON, no `Content-Length`
 * header, no `jsonrpc` field anywhere, `id` is a client-assigned incrementing integer
 * starting at 1, and the `params` key is omitted entirely (never sent as `null`) when
 * a request/notification has no payload.
 */
export interface CodexClientLike {
  /** Boot the transport (spawn the child / attach the streams). MUST be awaited first. */
  start(): Promise<void>
  /** Send a client→server request `{ id, method, params? }`; resolves with `result`, rejects on `error`. */
  request(method: string, params?: unknown): Promise<unknown>
  /** Send a client→server notification `{ method, params? }` — no response expected. */
  notify(method: string, params?: unknown): void
  /** Subscribe to id-less inbound `{ method, params? }` messages. */
  onNotification(cb: (msg: { method: string; params?: unknown }) => void): void
  /**
   * Subscribe to id-bearing inbound `{ id, method, params? }` messages (server-initiated
   * requests, e.g. approvals). The callback's resolved value is written back as
   * `{ id, result }`; a thrown/rejected error is written back as
   * `{ id, error: { code: -32603, message } }`.
   */
  onServerRequest(
    cb: (req: { id: number; method: string; params?: unknown }) => Promise<unknown>
  ): void
  /**
   * Subscribe to child/transport exit. The transport does NOT reject in-flight requests
   * on exit, so without this signal a session whose child dies mid-turn (after `turn/start`
   * has resolved and the notification stream goes silent) would block `events()` forever.
   * The codex driver wires this to end/crash the stream — the analog of copilot's
   * `session.shutdown` event. Optional so factories/tests that never spawn a real child can
   * omit it (their exit is signalled through `stop()`/`forceStop()` instead).
   */
  onExit?(cb: (info?: { code: number | null; signal: string | null }) => void): void
  /** Graceful shutdown: end stdin, give the child a chance to exit, escalate to SIGKILL. */
  stop(): Promise<void>
  /** Forceful shutdown for the error path — never leave an orphaned runtime. */
  forceStop(): Promise<void>
}

export type CodexClientFactory = (opts: {
  spawn: { command: string; args: string[]; env: NodeJS.ProcessEnv }
}) => CodexClientLike

/** Shape of a decoded inbound wire line — a union of all four envelope kinds. */
interface InboundEnvelope {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** Minimal duplex seam a factory wires up: write outgoing lines, receive raw incoming chunks. */
interface ClientIo {
  write(line: string): void
  onData(cb: (chunk: string) => void): void
}

/** Start/stop/forceStop are the only lifecycle bits that differ per factory (real spawn vs in-memory streams). */
interface ClientLifecycle {
  start(): Promise<void>
  stop(): Promise<void>
  forceStop(): Promise<void>
}

/**
 * Shared core: JSONL framing (buffer-the-remainder split-on-`\n`, strip trailing
 * `\r`, ignore blank lines) plus id correlation and request/notification/server-request
 * routing. Built once and reused by both `defaultCodexClientFactory` (real child
 * process) and `createCodexClientOverStreams` (in-memory test seam) so the framing/
 * routing logic has a single source of truth.
 */
function createRpcClient(io: ClientIo, lifecycle: ClientLifecycle): CodexClientLike {
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  let notificationCb: ((msg: { method: string; params?: unknown }) => void) | undefined
  let serverRequestCb:
    ((req: { id: number; method: string; params?: unknown }) => Promise<unknown>) | undefined
  let remainder = ''

  function handleResponse(msg: InboundEnvelope): void {
    const id = msg.id as number
    const entry = pending.get(id)
    if (!entry) return // no matching pending request — drop (e.g. late/duplicate response)
    pending.delete(id)
    if (msg.error) {
      const err = new Error(msg.error.message)
      Object.assign(err, { code: msg.error.code, data: msg.error.data })
      entry.reject(err)
    } else {
      entry.resolve(msg.result)
    }
  }

  async function handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    if (!serverRequestCb) return
    try {
      const result = await serverRequestCb({ id, method, params })
      io.write(`${JSON.stringify({ id, result })}\n`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      io.write(`${JSON.stringify({ id, error: { code: -32603, message } })}\n`)
    }
  }

  function routeMessage(msg: InboundEnvelope): void {
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined) {
        void handleServerRequest(msg.id, msg.method, msg.params)
      } else {
        notificationCb?.({ method: msg.method, params: msg.params })
      }
      return
    }
    if (msg.id !== undefined) {
      handleResponse(msg)
    }
    // Neither a method-bearing message nor an id-bearing response — unroutable; drop it.
  }

  function handleLine(line: string): void {
    if (line.trim().length === 0) return
    let msg: InboundEnvelope
    try {
      msg = JSON.parse(line) as InboundEnvelope
    } catch {
      return // malformed line — drop rather than crash the reader
    }
    routeMessage(msg)
  }

  io.onData((chunk) => {
    remainder += chunk
    const lines = remainder.split('\n')
    remainder = lines.pop() ?? ''
    for (const raw of lines) {
      handleLine(raw.replace(/\r$/, ''))
    }
  })

  return {
    start: () => lifecycle.start(),
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        io.write(`${JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) })}\n`)
      })
    },
    notify(method, params) {
      io.write(`${JSON.stringify({ method, ...(params !== undefined ? { params } : {}) })}\n`)
    },
    onNotification(cb) {
      notificationCb = cb
    },
    onServerRequest(cb) {
      serverRequestCb = cb
    },
    stop: () => lifecycle.stop(),
    forceStop: () => lifecycle.forceStop()
  }
}

const STOP_GRACE_MS = 5000

/**
 * The production factory: spawns `codex app-server` (command/args/env supplied by the
 * caller) and wires stdout→parser, stdin←writer. Mirrors copilot's `client.ts` spawn +
 * reap idioms (stream error listeners to avoid unhandled EPIPE crashes; `stop()` closes
 * stdin and waits, escalating to SIGKILL; `forceStop()` kills immediately). The `codex`
 * binary is not installed on this dev machine — that's fine, this factory is only
 * exercised by the real-runtime smoke test (deferred to a later task).
 */
export const defaultCodexClientFactory: CodexClientFactory = (opts) => {
  let child: ChildProcessWithoutNullStreams | null = null
  let dataCallback: ((chunk: string) => void) | undefined
  let exitCb: ((info?: { code: number | null; signal: string | null }) => void) | undefined
  let exitFired = false
  const fireExit = (info?: { code: number | null; signal: string | null }): void => {
    if (exitFired) return
    exitFired = true
    exitCb?.(info)
  }

  const io: ClientIo = {
    write(line) {
      const stdin = child?.stdin
      if (!stdin || stdin.destroyed || stdin.writableEnded) return
      stdin.write(line)
    },
    onData(cb) {
      dataCallback = cb
    }
  }

  const lifecycle: ClientLifecycle = {
    start: async () => {
      child = spawn(opts.spawn.command, opts.spawn.args, {
        env: opts.spawn.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      // Swallow async stream errors (e.g. EPIPE from a broken-pipe write after the
      // child dies mid-dispatch) — without a listener these crash the main process.
      child.stdin.on('error', () => {})
      child.stdout.on('error', () => {})
      child.stderr.on('error', () => {})
      child.stdout.on('data', (chunk: string) => dataCallback?.(chunk))
      // Surface an unexpected death so the driver can end/crash a hung session rather than
      // block forever on the (now-silent) notification stream. `error` (e.g. ENOENT) and
      // `exit` are collapsed to a single fire.
      child.on('error', () => fireExit({ code: null, signal: null }))
      child.on('exit', (code, signal) => fireExit({ code, signal }))
    },
    stop: async () => {
      if (!child || child.exitCode !== null) return
      const proc = child
      proc.stdin.end()
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          proc.kill('SIGKILL')
          resolve()
        }, STOP_GRACE_MS)
        proc.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
    forceStop: async () => {
      child?.kill('SIGKILL')
    }
  }

  return {
    ...createRpcClient(io, lifecycle),
    onExit(cb) {
      exitCb = cb
    }
  }
}

/**
 * Test seam over in-memory streams: no real process spawn. `serverWrite` plays the
 * server's role — pass a message object to have it JSON-encoded and newline-terminated
 * automatically, or pass a raw string to inject exact partial/blank-line bytes (for
 * chunk-boundary and blank-line framing tests). `nextClientWrite` resolves with the
 * next JSON message the client wrote (decoded), FIFO-queued if writes arrive before
 * they're awaited.
 */
export function createCodexClientOverStreams(): {
  client: CodexClientLike
  serverWrite: (msg: unknown) => void
  nextClientWrite: () => Promise<unknown>
} {
  const toClient = new PassThrough() // server → client (stands in for child.stdout)
  const toServer = new PassThrough() // client → server (stands in for child.stdin)

  let dataCallback: ((chunk: string) => void) | undefined
  toClient.on('data', (chunk: Buffer | string) => dataCallback?.(chunk.toString('utf8')))

  const writeQueue: unknown[] = []
  const waiters: Array<(v: unknown) => void> = []
  let remainder = ''
  toServer.on('data', (chunk: Buffer | string) => {
    remainder += chunk.toString('utf8')
    const lines = remainder.split('\n')
    remainder = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '')
      if (line.trim().length === 0) continue
      const msg: unknown = JSON.parse(line)
      const waiter = waiters.shift()
      if (waiter) waiter(msg)
      else writeQueue.push(msg)
    }
  })

  let exitCb: ((info?: { code: number | null; signal: string | null }) => void) | undefined
  let exitFired = false
  const fireExit = (): void => {
    if (exitFired) return
    exitFired = true
    exitCb?.({ code: null, signal: null })
  }
  // The "server" end going away (destroyed transport) is this seam's death signal.
  toClient.on('close', fireExit)

  const io: ClientIo = {
    write(line) {
      toServer.write(line)
    },
    onData(cb) {
      dataCallback = cb
    }
  }

  const lifecycle: ClientLifecycle = {
    start: async () => {},
    stop: async () => {
      toServer.end()
    },
    forceStop: async () => {
      toServer.destroy()
      toClient.destroy()
    }
  }

  return {
    client: {
      ...createRpcClient(io, lifecycle),
      onExit(cb) {
        exitCb = cb
      }
    },
    serverWrite(msg) {
      toClient.write(typeof msg === 'string' ? msg : `${JSON.stringify(msg)}\n`)
    },
    nextClientWrite() {
      if (writeQueue.length > 0) return Promise.resolve(writeQueue.shift())
      return new Promise((resolve) => waiters.push(resolve))
    }
  }
}
