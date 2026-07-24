import type { AgentEvent } from '../../../../../shared/agent-events'
import { PERMISSION_MODES } from '../../../../../shared/settings'
import { AsyncQueue } from '../../asyncQueue'
import type {
  AgentDriver,
  DriverSession,
  DriverSessionContext,
  ProbeAuthResult,
  ToolDecision
} from '../../driver'
import { ACP_TOOL_TAXONOMY } from './taxonomy'
import { synthesizeAcpPermission } from './mapping'
import { createAcpNormalizer } from './normalize'
import {
  defaultAcpClientFactory,
  type AcpClientFactory,
  type AcpClientLike,
  type AcpNewSessionConfig,
  type AcpPermissionDecision,
  type AcpPermissionOption,
  type AcpPermissionRequest,
  type AcpSessionLike,
  type AcpSessionUpdate
} from './client'
import type { AcpAgentProfile } from './profiles/types'

/** A fatal stream error is threaded through the events queue as this sentinel so it can
 *  propagate out of `events()` (contract invariant 5) without an out-of-band throw. Mirrors
 *  `copilot/index.ts`'s `FatalItem`. */
interface FatalItem {
  __fatal: unknown
}
type QueueItem = AcpSessionUpdate | FatalItem
function isFatal(item: QueueItem): item is FatalItem {
  return typeof item === 'object' && item !== null && '__fatal' in item
}

const AUTH_ERROR_PATTERN = /auth|unauthorized|api key/i

/** Matches `normalize.ts`'s `authErrorResult` heuristic exactly, so `CaseSession`'s
 *  consume-catch classifies the same failures the in-stream path already recognized. */
export function isAcpAuthErrorMessage(message: string): boolean {
  return AUTH_ERROR_PATTERN.test(message)
}

/** `NodeJS.ProcessEnv` allows `undefined` values (unset-but-present keys); `AcpSpawnOpts.env`
 *  is a strict `Record<string,string>`. Filter rather than cast so a real `undefined` never
 *  becomes the string `"undefined"` on the child's environment. */
function toEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * Best-effort translation of Argus's composed connector servers (`ctx.extraMcpServers`) into
 * ACP `NewSessionRequest.mcpServers`. FOLLOW-UP (flagged, not guessed): the real ACP `McpServer`
 * variants require a `name` field and an `env: EnvVariable[]` array (`{name,value}` pairs), not
 * the Argus composed shape's `Record<string,string>` env and id-keyed map — schema.d.ts confirmed
 * (Task 6 investigation), no live ACP MCP fixture exists yet to verify the correct field mapping
 * empirically. Returns `[]` rather than guess a shape that silently drops or malforms servers;
 * revisit once a live fixture is captured (see `__fixtures__/EVIDENCE.md`).
 */
function toAcpMcpServers(extra: Record<string, unknown>): unknown[] {
  void extra
  return []
}

/** Map the harness `ToolDecision` (+ mode short-circuits) onto one of the ACP request's own
 *  `options`, by `AcpPermissionOption.kind`. allow → `allow_once`, else `allow_always`, else
 *  the first option (some agents only ever offer one). deny → `reject_once`, else
 *  `reject_always`, else `{cancelled:true}` (no reject option present — nothing safe to pick). */
export function decisionToOptionId(
  decision: ToolDecision,
  options: readonly AcpPermissionOption[]
): AcpPermissionDecision {
  if (decision.behavior === 'allow') {
    const opt =
      options.find((o) => o.kind === 'allow_once') ??
      options.find((o) => o.kind === 'allow_always') ??
      options[0]
    return opt ? { optionId: opt.optionId } : { cancelled: true }
  }
  const opt =
    options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always')
  return opt ? { optionId: opt.optionId } : { cancelled: true }
}

export interface AcpDriverDeps {
  /** Injected at the client.ts seam; tests pass a scripted fake to avoid a real subprocess. */
  clientFactory?: AcpClientFactory
}

export function createAcpDriver(profile: AcpAgentProfile, deps: AcpDriverDeps = {}): AgentDriver {
  const clientFactory = deps.clientFactory ?? defaultAcpClientFactory

  return {
    kind: profile.kind,
    toolTaxonomy: ACP_TOOL_TAXONOMY,
    authFixHint: profile.auth.loginHint,
    ...(profile.npmPackage ? { npmPackage: profile.npmPackage } : {}),
    ...(profile.updateCommand ? { updateCommand: profile.updateCommand } : {}),
    // MUST stay byte-identical to the shared catalog entry (`shared/drivers.ts` cursor/grok) —
    // Task 2's contract.
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: false,
      costReporting: false,
      planMode: true,
      headlessOneShot: false
    },

    isAuthErrorMessage: isAcpAuthErrorMessage,

    createSession(ctx: DriverSessionContext): DriverSession {
      const queue = new AsyncQueue<QueueItem>()
      const model = profile.resolveModel?.(ctx.model ?? '') ?? ctx.model ?? 'auto'
      const norm = createAcpNormalizer({ resumed: Boolean(ctx.resumeCursor), model })

      let session: AcpSessionLike | null = null
      let client: AcpClientLike | null = null
      const pendingPrompts: string[] = []
      let ended = false
      let stopped = false
      // Set by interrupt() before session.cancel(); read once the in-flight prompt() settles
      // so the synthetic turn-boundary item (below) reports the right outcome.
      let cancelRequested = false
      // Exit-plan approval is raised at most once per turn (reset when a new prompt starts) —
      // a chatty `plan` stream must not spam duplicate approval cards.
      let planApprovalRaised = false

      // Aborts pending approval promises when the session ends/interrupts, so a card left
      // open at teardown rejects instead of dangling.
      const abort = new AbortController()

      const stopClient = (): void => {
        if (stopped) return
        stopped = true
        // client may still be initializing — chain on `ready` so stop can never race init.
        void ready.finally(async () => {
          await client?.stop().catch(() => undefined)
        })
      }

      const doPrompt = (text: string): void => {
        if (!session) return
        planApprovalRaised = false
        cancelRequested = false
        session
          .prompt(text)
          .then(() => {
            // ACP's real `PromptResponse.stopReason` is discarded by `AcpSessionLike.prompt`
            // (Promise<void>) — see client.ts. Turn completion is signaled by the prompt
            // promise settling, not by a `session/update`, so thread a synthetic boundary item
            // into the queue for `norm.turnBoundary` to recognize (ASSUMED, brief-directed:
            // no live fixture threads the real stopReason through this seam yet).
            queue.push({
              type: 'turn.completed',
              stopReason: cancelRequested ? 'cancelled' : 'end_turn'
            })
          })
          .catch((err: unknown) => {
            // Mirrors Copilot's session.error channel: an auth-shaped rejection is non-fatal
            // (the normalizer extracts a TurnResult with authFailure and the stream
            // continues); anything else is fatal and propagates out of events().
            const message = err instanceof Error ? err.message : String(err)
            queue.push({ type: 'error', message })
          })
      }

      const onPermission = async (req: AcpPermissionRequest): Promise<AcpPermissionDecision> => {
        const kind = String(req.toolCall.kind ?? 'other')

        // Permission-mode short-circuits mirror Copilot's (canUseTool is NOT called for
        // auto-approved requests): decide WITHOUT opening an Argus card.
        if (ctx.permissionMode === 'bypassPermissions') {
          return decisionToOptionId({ behavior: 'allow', updatedInput: {} }, req.options)
        }
        if (
          ctx.permissionMode === 'acceptEdits' &&
          (kind === 'edit' || kind === 'delete' || kind === 'move')
        ) {
          const rawInput = req.toolCall.rawInput ?? {}
          const { name, input } = synthesizeAcpPermission(kind, rawInput)
          const verdict = ctx.classifyOnly?.(name, input)
          if (verdict?.action === 'deny') {
            return decisionToOptionId(
              { behavior: 'deny', message: verdict.reason ?? 'Denied by sandbox policy' },
              req.options
            )
          }
          return decisionToOptionId({ behavior: 'allow', updatedInput: {} }, req.options)
        }

        const rawInput = req.toolCall.rawInput ?? {}
        const { name, input } = synthesizeAcpPermission(kind, rawInput)
        if (abort.signal.aborted) return { cancelled: true }
        const decision = await ctx.onToolRequest(name, input, { signal: abort.signal })
        if (abort.signal.aborted) return { cancelled: true }
        return decisionToOptionId(decision, req.options)
      }

      // Async session bootstrap. Init failures here (spawn/initialize/newSession) propagate
      // out of events() as a fatal item, mirroring Copilot's `ready`.
      const ready: Promise<void> = (async () => {
        const spawn = profile.spawn({ cliPath: ctx.cliPath })
        client = clientFactory({
          spawn: { command: spawn.command, args: spawn.args, env: toEnvRecord(spawn.env) },
          onPermission,
          // Unused fallback: the per-session `session.onUpdate` callback below is the
          // authoritative sink (see client.ts's `routeSessionUpdate` precedence).
          onUpdate: () => {}
        })
        await client.start()

        const mcpServers = toAcpMcpServers(ctx.extraMcpServers ?? {})
        const sessionConfig: AcpNewSessionConfig = {
          cwd: ctx.caseDir,
          ...(mcpServers.length > 0 ? { mcpServers } : {})
        }

        session = ctx.resumeCursor
          ? await client.loadSession(ctx.resumeCursor, sessionConfig)
          : await client.newSession(sessionConfig)

        // Cursor = the ACP sessionId, known synchronously once the session exists.
        ctx.onCursor(session.sessionId)

        // Some agents (per profile) require an explicit `session/set_model` request rather
        // than accepting a model at `newSession` time; optional-chained so a fake/agent
        // without the method no-ops (Task 7 implements the real request).
        if (profile.selectModelAfterStart) {
          await session.setModel?.(model)
        }

        session.onUpdate((u: AcpSessionUpdate) => {
          if (u?.sessionUpdate === 'plan' && !planApprovalRaised) {
            planApprovalRaised = true
            // ASSUMED — no live plan-mode fixture (EVIDENCE.md gap): raise an exit-plan
            // approval card fire-and-forget so it never blocks or duplicates the normal event
            // stream (the `plan` update itself normalizes to `[]`, Task 4). A rejected/failed
            // approval is swallowed here; Task 8/9 should revisit once plan mode is captured
            // live and wire a real accept/reject action if the ACP agent exposes one.
            ctx
              .onToolRequest('acp:exit-plan', { entries: u.entries }, { signal: abort.signal })
              .catch(() => undefined)
          }
          queue.push(u)
        })

        for (const p of pendingPrompts) doPrompt(p)
        pendingPrompts.length = 0
      })().catch((err) => {
        queue.push({ __fatal: err })
      })

      async function* events(): AsyncIterable<AgentEvent> {
        try {
          for await (const item of queue) {
            if (isFatal(item)) throw item.__fatal
            const raw = item

            // A typed auth error drives the auth verdict; the stream continues (mirrors
            // Copilot's non-fatal session.error+authFailure path).
            const authResult = norm.authErrorResult(raw)
            if (authResult) ctx.onTurnResult(authResult)

            // Any other `type: 'error'` item is fatal — propagate so the harness emits
            // session.error + session.exited('crashed') (contract invariant 5).
            if (raw?.type === 'error' && !authResult) {
              throw new Error(String(raw.message ?? 'ACP session error'))
            }

            // Contract invariant 7: onTurnResult MUST fire before turn.completed is yielded.
            const boundary = norm.turnBoundary(raw)
            if (boundary) ctx.onTurnResult(norm.turnResult())

            for (const ev of norm.normalize(raw, ctx.eventCtx())) yield ev
          }
        } finally {
          // ANY stream termination tears down the runtime — normal end, a thrown fatal, or the
          // consumer breaking out. Idempotent; also invoked from end().
          stopClient()
        }
      }

      return {
        events,
        send(text: string): void {
          if (ended) return
          if (session) doPrompt(text)
          else pendingPrompts.push(text)
        },
        async interrupt(): Promise<void> {
          await ready.catch(() => undefined)
          cancelRequested = true
          abort.abort()
          await session?.cancel().catch(() => undefined)
        },
        end(): void {
          if (ended) return
          ended = true
          abort.abort() // reject any approval card still pending at teardown
          queue.end()
          stopClient() // never leave an orphaned runtime
        }
      }
    },

    /**
     * MINIMAL probe (Task 6 scope only — Task 10 hardens this into a bounded live handshake).
     * Without a spawned-and-verified round trip we can only check the precondition the profile
     * itself declares: its auth env var is set. A profile with no `auth.envVar` (no known
     * static precondition) reports ok optimistically rather than failing closed on nothing.
     */
    async probeAuth(): Promise<ProbeAuthResult> {
      const envVar = profile.auth.envVar
      if (envVar && !process.env[envVar]) {
        return { ok: false, detail: profile.auth.loginHint }
      }
      return { ok: true, detail: `${profile.displayName} ready` }
    }
  }
}
