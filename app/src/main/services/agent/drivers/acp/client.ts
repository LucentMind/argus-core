import { spawn as spawnChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type LoadSessionRequest,
  type NewSessionRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification
} from '@zed-industries/agent-client-protocol'

/**
 * ISOLATION SEAM: this is the ONLY file in the codebase allowed to import
 * `@zed-industries/agent-client-protocol` (deprecated upstream in favor of
 * `@agentclientprotocol/sdk` — same API — per Task 1's EVIDENCE.md). Every other module
 * (normalize.ts, mapping.ts, taxonomy.ts, and the Task 6 driver) talks to the structural
 * `AcpClientLike`/`AcpSessionLike` interfaces below, never the library directly, so a future
 * re-pin/rename only touches this file. Mirrors `copilot/client.ts`'s isolation role.
 *
 * Real library facts this file relies on (verified against the installed `0.4.5` `.d.ts`,
 * NOT guessed — see EVIDENCE.md §1-5):
 *  - There is no fluent `client()` export; the Client-role entry point is the
 *    `ClientSideConnection` class over a `Stream` built by `ndJsonStream`.
 *  - `Stream` is a Web Streams pair; a Node child's stdio is bridged via
 *    `Writable.toWeb(child.stdin)` / `Readable.toWeb(child.stdout)`.
 *  - `Client.sessionUpdate(params)` receives `{ sessionId, update }` — `update` is the FLAT
 *    discriminated sub-object (`{ sessionUpdate: '...', ... }`) that the Task 4 normalizer
 *    expects, not the outer `params`.
 *  - `Client.requestPermission` must resolve with the real double-nested outcome shape:
 *    `{ outcome: { outcome: 'selected', optionId } | { outcome: 'cancelled' } }`.
 */

/** Fully-assembled child-process launch parameters (resolved by the caller — e.g. the Task
 *  6/7 driver picks `cursor-agent`/`grok`'s binary, argv, and auth env vars). This wrapper
 *  never second-guesses them. */
export interface AcpSpawnOpts {
  command: string
  args: string[]
  env: Record<string, string>
}

/** The permission-option shape a decision is chosen from (ACP `PermissionOption`, EVIDENCE
 *  §5): `kind` here is `allow_once|allow_always|reject_once|reject_always` — NOT the
 *  10-value `ToolKind` (that one lives at `toolCall.kind` below). */
export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

/** Structural subset of the real `RequestPermissionRequest` (EVIDENCE §5) that a permission
 *  decision needs. Declared locally (not re-exported from the library) so this type alone
 *  doesn't force downstream files to know about the library's schema module — the real
 *  request object the library hands us is structurally assignable to this. */
export interface AcpPermissionRequest {
  sessionId: string
  toolCall: {
    toolCallId: string
    /** The 10-value ACP `ToolKind` (`read|edit|delete|move|search|execute|think|fetch|
     *  switch_mode|other`), not the 4-value `AcpPermissionOption.kind` above. */
    kind?: string | null
    title?: string | null
  }
  options: AcpPermissionOption[]
}

/** The injected permission callback's verdict. `cancelled` mirrors the ACP requirement that
 *  a `session/cancel`-interrupted turn MUST resolve any in-flight permission request with the
 *  cancelled outcome (EVIDENCE §5) — the Task 6 driver decides when that applies. */
export type AcpPermissionDecision = { optionId: string } | { cancelled: true }

/** Config for creating/loading a session. All fields optional so callers (and this task's
 *  unit test) can pass `{}` — `defaultAcpClientFactory` fills in sane defaults. */
export interface AcpNewSessionConfig {
  cwd?: string
  mcpServers?: unknown[]
}

export interface AcpSessionLike {
  readonly sessionId: string
  /** Send a user prompt as a single text content block; resolves once the agent's turn ends. */
  prompt(text: string): Promise<void>
  /** Request cancellation of the in-flight turn (ACP `session/cancel` notification). */
  cancel(): Promise<void>
  /** Subscribe this session's `session/update` stream. The flat `update` sub-object is
   *  forwarded (same shape as the factory-level `onUpdate` below), scoped to this session's
   *  `sessionId`. */
  onUpdate(cb: (update: AcpSessionUpdate) => void): void
}

export interface AcpClientLike {
  /** Boot the transport: spawn the agent process and run the `initialize` handshake. */
  start(): Promise<void>
  newSession(cfg: AcpNewSessionConfig): Promise<AcpSessionLike>
  loadSession(sessionId: string, cfg: AcpNewSessionConfig): Promise<AcpSessionLike>
  /** Tear down the spawned child process. */
  stop(): Promise<void>
}

/** One flat `session/update` sub-object (`params.update`, discriminated by `sessionUpdate`).
 *  Kept as a loose structural type here (mirrors `AcpNormalizer.normalize`'s `any` in
 *  normalize.ts) since the 8 real variants are normalize.ts's concern, not this seam's. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AcpSessionUpdate = any

export interface AcpClientFactoryOpts {
  spawn: AcpSpawnOpts
  /** Called for every `session/request_permission`, across all sessions on this client. */
  onPermission: (request: AcpPermissionRequest) => Promise<AcpPermissionDecision>
  /** Called for every `session/update`, across all sessions, with the flat `update`
   *  sub-object (non-negotiable: NOT the whole `{sessionId, update}` params). */
  onUpdate: (update: AcpSessionUpdate) => void
}

export type AcpClientFactory = (opts: AcpClientFactoryOpts) => AcpClientLike

/** Cap on the retained stderr tail (bytes, approx. — measured in JS string chars after utf8
 *  decode) so a chatty agent can't grow this without bound; see `attachStderrDrain` below. */
const STDERR_TAIL_MAX_CHARS = 8 * 1024

/** How long `stop()` waits after SIGTERM before escalating to SIGKILL. */
const STOP_GRACE_MS = 2000

/**
 * Drain `stream` so a child that writes a lot to stderr can never block on its own pipe
 * filling up (Node pipes back-pressure at ~64KB on most platforms — an agent that logs
 * verbosely and blocks on that write would hang the whole ACP session, since nothing here
 * ever reads stdout/exits either). Keeps only the last `STDERR_TAIL_MAX_CHARS` so retention is
 * bounded regardless of how long the child runs. Returns a getter for the current tail so a
 * caller can surface it for diagnostics (e.g. attach to a spawn/exit error) without this
 * module needing to know how errors are reported upstream.
 */
function attachStderrDrain(stream: NodeJS.ReadableStream): () => string {
  let tail = ''
  stream.on('data', (chunk: Buffer | string) => {
    tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL_MAX_CHARS)
  })
  // Same rationale as the child's own 'error' listener below: never let a broken pipe on
  // this stream surface as an unhandled 'error' event.
  stream.on('error', () => {})
  return () => tail
}

/**
 * Routes one `session/update` notification to exactly one destination — never both, so a
 * per-session subscriber (Task 6's driver, via `AcpSessionLike.onUpdate`) and the factory-level
 * `opts.onUpdate` can't both receive the same event and double the transcript. Precedence:
 *  1. **Per-session callback is authoritative.** If `sessionUpdateCallbacks` has an entry for
 *     `params.sessionId` (the driver has subscribed via `AcpSessionLike.onUpdate`), deliver
 *     ONLY to it — mirrors the Copilot driver's single per-session sink (`session.on(...)`).
 *  2. **Factory-level `onUpdate` is the fallback**, firing only when no per-session callback is
 *     registered for that session yet (e.g. an update arrives before the driver subscribes).
 * Exported standalone (not inlined in `Client.sessionUpdate`) so this precedence is directly
 * unit-testable without spawning a live ACP agent subprocess.
 */
export function routeSessionUpdate(
  params: SessionNotification,
  sessionUpdateCallbacks: ReadonlyMap<string, (update: AcpSessionUpdate) => void>,
  onUpdate: (update: AcpSessionUpdate) => void
): void {
  const perSession = sessionUpdateCallbacks.get(params.sessionId)
  if (perSession) {
    perSession(params.update)
  } else {
    onUpdate(params.update)
  }
}

/**
 * The production factory: spawns the agent subprocess, bridges its stdio into the library's
 * `ClientSideConnection`, and adapts the two required `Client` callbacks
 * (`requestPermission`/`sessionUpdate`) onto the injected `onPermission`/`onUpdate`. `fs.*`
 * and `terminal` capabilities are deliberately NOT advertised at `initialize` (we don't
 * implement `readTextFile`/`writeTextFile`/terminal methods yet) — an agent that respects
 * `clientCapabilities` won't call them; wiring those up is a future task if an agent needs it.
 */
export const defaultAcpClientFactory: AcpClientFactory = (opts) => {
  const child = spawnChildProcess(opts.spawn.command, opts.spawn.args, {
    // `env` REPLACES the child's env if passed bare (same trap as Copilot's SDK, EVIDENCE
    // for that driver) — spread process.env first so PATH/HOME survive.
    env: { ...process.env, ...opts.spawn.env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  // Never let a spawn/runtime error crash the process with an unhandled 'error' event; the
  // caller observes failure via the initialize/session promises rejecting instead.
  child.on('error', () => {})
  // `child.stderr` MUST be drained: an unconsumed pipe fills up (~64KB) and a verbose agent
  // blocks on its own write, hanging the whole session (nothing else reads stdout or exits to
  // unblock it). The bounded tail is retained and stitched onto rejections below (see
  // `withStderrContext`) so a spawn/protocol failure carries the agent's own diagnostics.
  const getStderrTail = child.stderr ? attachStderrDrain(child.stderr) : () => ''

  /** Re-throws `fn`'s rejection with the current stderr tail appended, when there is one —
   *  the agent's own stderr output is often the actual explanation for an `initialize`/
   *  `newSession`/`loadSession` failure (bad auth, missing config, crash on startup). */
  async function withStderrContext<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      const tail = getStderrTail()
      if (!tail) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`${message}\n--- agent stderr (tail) ---\n${tail}`)
    }
  }

  const sessionUpdateCallbacks = new Map<string, (update: AcpSessionUpdate) => void>()

  const clientImpl: Client = {
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const decision = await opts.onPermission(params)
      if ('cancelled' in decision) {
        return { outcome: { outcome: 'cancelled' } }
      }
      return { outcome: { outcome: 'selected', optionId: decision.optionId } }
    },
    async sessionUpdate(params: SessionNotification): Promise<void> {
      routeSessionUpdate(params, sessionUpdateCallbacks, opts.onUpdate)
    }
  }

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
  )
  const conn = new ClientSideConnection(() => clientImpl, stream)

  function makeSession(sessionId: string): AcpSessionLike {
    return {
      sessionId,
      async prompt(text: string): Promise<void> {
        await conn.prompt({ sessionId, prompt: [{ type: 'text', text }] })
      },
      async cancel(): Promise<void> {
        await conn.cancel({ sessionId })
      },
      onUpdate(cb: (update: AcpSessionUpdate) => void): void {
        sessionUpdateCallbacks.set(sessionId, cb)
      }
    }
  }

  return {
    async start(): Promise<void> {
      await withStderrContext(() =>
        conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
        })
      )
    },
    async newSession(cfg: AcpNewSessionConfig): Promise<AcpSessionLike> {
      const req: NewSessionRequest = {
        cwd: cfg.cwd ?? process.cwd(),
        mcpServers: (cfg.mcpServers as NewSessionRequest['mcpServers']) ?? []
      }
      const res = await withStderrContext(() => conn.newSession(req))
      return makeSession(res.sessionId)
    },
    async loadSession(sessionId: string, cfg: AcpNewSessionConfig): Promise<AcpSessionLike> {
      const req: LoadSessionRequest = {
        sessionId,
        cwd: cfg.cwd ?? process.cwd(),
        mcpServers: (cfg.mcpServers as LoadSessionRequest['mcpServers']) ?? []
      }
      await withStderrContext(() => conn.loadSession(req))
      return makeSession(sessionId)
    },
    /** SIGTERM first, then escalate to SIGKILL if the child hasn't exited within
     *  `STOP_GRACE_MS` — a hung/ignoring agent must not leave `stop()` resolved with the
     *  process still alive (the original version resolved immediately after `child.kill()`
     *  without ever confirming exit). Resolves once the child is actually gone. */
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill('SIGKILL')
        }, STOP_GRACE_MS)
        child.once('exit', () => {
          clearTimeout(killTimer)
          resolve()
        })
        child.kill('SIGTERM')
      })
    }
  }
}
