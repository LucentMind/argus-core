import os from 'node:os'
import type { AgentEvent } from '../../../../../shared/agent-events'
import { PERMISSION_MODES } from '../../../../../shared/settings'
import { AsyncQueue } from '../../asyncQueue'
import type {
  AgentDriver,
  DriverSession,
  DriverSessionContext,
  ProbeAuthResult
} from '../../driver'
import { COPILOT_TOOL_TAXONOMY } from './taxonomy'
import {
  createCopilotNormalizer,
  COPILOT_AUTH_ERROR_SUBSTRING,
  type RawSdkEvent
} from './normalize'
import {
  copilotHome,
  defaultClientFactory,
  type CopilotClientFactory,
  type CopilotClientLike,
  type CopilotSessionConfig,
  type CopilotSessionLike
} from './client'

/** A fatal stream error is threaded through the events queue as this sentinel so it can
 *  propagate out of `events()` (contract invariant 5) without an out-of-band throw. */
interface FatalItem {
  __fatal: unknown
}
type QueueItem = RawSdkEvent | FatalItem
function isFatal(item: QueueItem): item is FatalItem {
  return typeof item === 'object' && item !== null && '__fatal' in item
}

export function isCopilotAuthErrorMessage(message: string): boolean {
  return message.includes(COPILOT_AUTH_ERROR_SUBSTRING)
}

// The SDK leaks an unhandled promise rejection on an unauthenticated turn that would
// crash the process if untrapped (EVIDENCE §7). Merely being attached, a listener
// suppresses Node's default handling for ALL rejections process-wide — so the trap must
// (a) swallow ONLY auth-shaped rejections (the same failure also arrives as a typed
// `session.error` that drives the auth verdict) and rethrow everything else on a fresh
// tick, where it becomes an uncaughtException and Node's default handling applies again;
// (b) be a single ref-counted process listener, so concurrent Copilot sessions never
// stack duplicate handlers that would each rethrow the same unrelated rejection.
const authRejectionTrap = (reason: unknown): void => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  if (isCopilotAuthErrorMessage(msg)) return // swallowed: prevents the process crash
  setImmediate(() => {
    throw reason instanceof Error ? reason : new Error(msg)
  })
}
let authTrapRefs = 0
function acquireAuthRejectionTrap(): () => void {
  if (authTrapRefs++ === 0) process.on('unhandledRejection', authRejectionTrap)
  let released = false
  return () => {
    if (released) return
    released = true
    if (--authTrapRefs === 0) process.off('unhandledRejection', authRejectionTrap)
  }
}

export interface CopilotDriverDeps {
  /** Injected at the client.ts seam; tests pass a scripted fake to avoid the real runtime. */
  clientFactory?: CopilotClientFactory
}

export function createCopilotDriver(
  config: { cliPath?: string } = {},
  deps: CopilotDriverDeps = {}
): AgentDriver {
  const clientFactory = deps.clientFactory ?? defaultClientFactory

  return {
    kind: 'github-copilot',
    toolTaxonomy: COPILOT_TOOL_TAXONOMY,
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: false, // permission channel cannot carry edited input (EVIDENCE §2)
      costReporting: false // free tier bills cost:0; costUsd is always null (§5, amendment 10)
    },

    isAuthErrorMessage: isCopilotAuthErrorMessage,

    createSession(ctx: DriverSessionContext): DriverSession {
      const queue = new AsyncQueue<QueueItem>()
      const norm = createCopilotNormalizer({
        resumed: Boolean(ctx.resumeCursor),
        model: ctx.model ?? 'auto'
      })

      let session: CopilotSessionLike | null = null
      let client: CopilotClientLike | null = null
      const pendingPrompts: string[] = []
      let ended = false
      let stopped = false

      // See authRejectionTrap above: swallow the SDK's leaked auth rejection for this
      // session's lifetime without hijacking unrelated rejections process-wide.
      const cleanup = acquireAuthRejectionTrap()

      const stopClient = (): void => {
        if (stopped) return
        stopped = true
        // client may still be initializing — chain on `ready` so stop can never race init.
        void ready.finally(async () => {
          try {
            await client?.stop()
          } catch {
            await client?.forceStop().catch(() => undefined)
          }
        })
      }

      const doSend = (text: string): void => {
        // The auth failure (and any hard send error) also surfaces as a `session.error`
        // event; swallow the promise rejection so it never escapes as unhandled.
        session?.send({ prompt: text }).catch(() => undefined)
      }

      const permissionHandler: CopilotSessionConfig['onPermissionRequest'] = async (request) => {
        // Minimal 9A seam: adapt the SDK permission request onto the harness approval
        // pipeline. Task 9B replaces this with per-`kind` argument extraction + taxonomy.
        const toolName = String(request?.toolName ?? request?.kind ?? 'unknown')
        const input = (request?.args ?? request?.input ?? {}) as Record<string, unknown>
        const decision = await ctx.onToolRequest(toolName, input, {
          signal: new AbortController().signal
        })
        if (decision.behavior === 'allow') return { kind: 'approve-once' }
        return { kind: 'reject', feedback: decision.message }
      }

      // Async session bootstrap. createSession succeeds even when unauthenticated (the
      // failure surfaces on the first turn), so init failures here are genuine (missing
      // runtime, bad config) and propagate out of events() as a fatal item.
      const ready: Promise<void> = (async () => {
        client = clientFactory({
          baseDirectory: copilotHome(ctx.nativeToolDeps.argusHome),
          workingDirectory: ctx.caseDir,
          ...(config.cliPath ? { cliPath: config.cliPath } : {})
        })
        await client.start() // boot the runtime transport before create/resume
        const sessionConfig: CopilotSessionConfig = {
          workingDirectory: ctx.caseDir,
          systemMessage: { mode: 'append', content: ctx.systemAppend },
          onPermissionRequest: permissionHandler
        }
        session = ctx.resumeCursor
          ? await client.resumeSession(ctx.resumeCursor, sessionConfig)
          : await client.createSession(sessionConfig)

        // Cursor = the Copilot sessionId (a stable UUID, unchanged across resume). Known
        // synchronously once the session exists (EVIDENCE §10, plan amendment 5).
        ctx.onCursor(session.sessionId)
        session.on((event) => queue.push(event))

        // Flush any prompts that arrived before the session was ready.
        for (const p of pendingPrompts) doSend(p)
        pendingPrompts.length = 0
      })().catch((err) => {
        queue.push({ __fatal: err })
      })

      async function* events(): AsyncIterable<AgentEvent> {
        try {
          for await (const item of queue) {
            if (isFatal(item)) throw item.__fatal
            const raw = item

            // Session termination — the SDK emits this once when the runtime shuts down
            // (client.stop()); end our normalized stream so the harness emits session.exited.
            if (raw.type === 'session.shutdown') return

            // A typed authentication error drives the auth verdict (onTurnResult with
            // authFailure) and is surfaced to the user; the stream continues (the fixture
            // shows session.error → assistant.idle → session.idle, no turn_end).
            const authResult = norm.authErrorResult(raw)
            if (authResult) ctx.onTurnResult(authResult)

            // Any other session.error is fatal — propagate so the harness emits
            // session.error + session.exited('crashed') (contract invariant 5).
            if (raw.type === 'session.error' && !authResult) {
              throw new Error(String(raw.data?.message ?? 'Copilot session error'))
            }

            // Contract invariant 7: onTurnResult MUST fire before turn.completed is yielded.
            const boundary = norm.turnBoundary(raw)
            if (boundary) ctx.onTurnResult(norm.turnResult())

            for (const ev of norm.normalize(raw, ctx.eventCtx())) yield ev
          }
        } finally {
          // ANY stream termination — normal end, a thrown fatal (init failure / non-auth
          // session.error), or the consumer breaking out — tears down the runtime. The
          // harness's consume-catch marks the session dead WITHOUT calling end() on the
          // crash path, so relying on end() alone would leak the spawned child process.
          stopClient() // idempotent; also invoked from end()
          cleanup()
        }
      }

      return {
        events,
        send(text: string): void {
          if (ended) return
          if (session) doSend(text)
          else pendingPrompts.push(text)
        },
        async interrupt(): Promise<void> {
          await ready.catch(() => undefined)
          await session?.abort().catch(() => undefined)
        },
        end(): void {
          if (ended) return
          ended = true
          queue.end()
          stopClient() // never leave an orphaned runtime
          cleanup()
        }
      }
    },

    /**
     * Turn-free probe: `getAuthStatus()` is reliable and cheap (EVIDENCE §7). A probe alone
     * never proves credentials work (only a real turn does), so we surface identity via
     * `detail` — deliberately NOT the `email` field, which `login` is not (plan amendment 4).
     */
    async probeAuth(config2: { cliPath?: string; timeoutMs?: number }): Promise<ProbeAuthResult> {
      let client: CopilotClientLike | null = null
      try {
        // A probe only needs a scratch home to boot the runtime; auth resolves via gh-cli
        // regardless. Use the OS temp dir so probing never pollutes the repo/cwd.
        const probeHome = copilotHome(os.tmpdir())
        client = clientFactory({
          baseDirectory: probeHome,
          workingDirectory: os.tmpdir(),
          ...((config2.cliPath ?? config.cliPath)
            ? { cliPath: config2.cliPath ?? config.cliPath }
            : {})
        })
        await client.start() // boot the runtime transport before querying auth
        const status = await client.getAuthStatus()
        const version = await client
          .getStatus()
          .then((s) => s.version)
          .catch(() => undefined)
        if (!status.isAuthenticated) {
          return {
            ok: false,
            detail: status.statusMessage ?? 'Copilot not authenticated — run `gh auth login`',
            ...(version ? { version } : {})
          }
        }
        const via = status.authType ? ` via ${status.authType}` : ''
        const who = status.login ? ` (${status.login}${via})` : via ? ` (${via.trim()})` : ''
        return {
          ok: true,
          detail: `copilot ready${who}`,
          ...(version ? { version } : {})
        }
      } catch (err) {
        return { ok: false, detail: (err as Error).message }
      } finally {
        await client?.stop().catch(() => client?.forceStop().catch(() => undefined))
      }
    }
  }
}
