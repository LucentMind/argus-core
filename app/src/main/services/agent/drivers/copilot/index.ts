import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { AgentEvent } from '../../../../../shared/agent-events'
import { PERMISSION_MODES } from '../../../../../shared/settings'
import { AsyncQueue } from '../../asyncQueue'
import { NATIVE_RISK } from '../../risk'
import { NATIVE_TOOL_SPECS, argusToolHandlers } from '../../nativeTools'
import { panelCommandDescription } from '../../panelCommands'
import type {
  AgentDriver,
  DriverSession,
  DriverSessionContext,
  ProbeAuthResult,
  ToolDecision
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
  type CopilotExitPlanModeResult,
  type CopilotSessionConfig,
  type CopilotSessionLike,
  type CopilotToolDef
} from './client'
import { acquireAuthRejectionTrap } from './authTrap'
import { runCopilotHeadless } from './headless'

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

const ARGUS_TOOL_PREFIX = 'argus_'

/** A canonical Argus/Copilot tool name + the input to hand `ctx.onToolRequest`, synthesized
 *  from one typed Copilot `PermissionRequest` (EVIDENCE §2/§3). */
export interface SynthesizedToolRequest {
  name: string
  input: Record<string, unknown>
}

/**
 * Map a typed Copilot permission request onto Argus's canonical (tool-name, input) pair.
 * `toolNameMap` reverses the driver's own registration names (`argus_<x>`, `panel_<…>`)
 * to their canonical `mcp__…` form for the risk classifier + events; it is authoritative
 * (built at session start), with an `argus_` prefix rule as the fallback for custom tools
 * the map doesn't know (e.g. a non-native `argus_*`). Unmapped/unknown kinds become
 * `copilot:<kind>` which — absent a taxonomy fallback — fails closed at HIGH ask.
 */
export function synthesizePermissionRequest(
  request: Record<string, unknown>,
  toolNameMap: ReadonlyMap<string, string> = new Map()
): SynthesizedToolRequest {
  const kind = String(request?.kind ?? 'unknown')
  const args = (request?.args as Record<string, unknown>) ?? {}
  switch (kind) {
    case 'write':
      return { name: 'write', input: { file_path: request.fileName, diff: request.diff } }
    case 'read':
      return { name: 'read', input: { file_path: request.path } }
    case 'shell':
      // Include the pre-parsed metadata so the approval card's input is informative; the
      // shell taxonomy still keys risk off `command` (fullCommandText), not these fields.
      return {
        name: 'shell',
        input: {
          command: request.fullCommandText,
          commands: request.commands,
          possiblePaths: request.possiblePaths,
          hasWriteFileRedirection: request.hasWriteFileRedirection
        }
      }
    case 'url':
      return { name: 'fetch', input: { url: request.url } }
    case 'mcp': {
      // The live runtime reports `toolName` in its model-facing prefixed form
      // (`<server>-<tool>`, e.g. "argusEcho-mcp_echo" — smoke (f) capture, EVIDENCE §6c);
      // strip the prefix so the canonical name is `mcp__<server>__<tool>` like Claude's.
      const server = String(request.serverName ?? '')
      const rawTool = String(request.toolName ?? '')
      const tool =
        server && rawTool.startsWith(`${server}-`) ? rawTool.slice(server.length + 1) : rawTool
      return { name: `mcp__${server}__${tool}`, input: args }
    }
    case 'custom-tool': {
      const toolName = String(request.toolName ?? '')
      const canonical =
        toolNameMap.get(toolName) ??
        (toolName.startsWith(ARGUS_TOOL_PREFIX)
          ? `mcp__argus__${toolName.slice(ARGUS_TOOL_PREFIX.length)}`
          : toolName)
      return { name: canonical, input: args }
    }
    default:
      // memory | hook | extension-management | extension-permission-access | unknown
      return { name: `copilot:${kind}`, input: { ...request } }
  }
}

/** Map the harness `ToolDecision` back to a Copilot `PermissionDecision`. The permission
 *  channel provably cannot carry edited input (EVIDENCE §2), so allow → approve-once
 *  (Argus owns session-scoping via its own grants, so the driver never emits
 *  approve-for-session — every call re-enters the classifier and is logged). */
export function mapToolDecision(
  decision: ToolDecision
): { kind: 'approve-once' } | { kind: 'reject'; feedback: string } {
  return decision.behavior === 'allow'
    ? { kind: 'approve-once' }
    : { kind: 'reject', feedback: decision.message }
}

/**
 * Exit-plan handshake, routed through the Argus approval pipeline. The live fixture
 * (15-exit-plan.jsonl) proved a bare `{approved:true}` flips the session plan→autopilot with
 * ZERO human gates — so the plan must be reviewed first. We synthesize it as the tool
 * `copilot:exit-plan` (no taxonomy entry → fail-closed HIGH ask), which raises an Argus
 * approval card carrying the plan content for the user to review.
 *
 * Decision mapping:
 *   allow / allow-session → `{approved:true, selectedAction: recommendedAction}`. The model
 *     leaves plan mode into autopilot, but every subsequent tool call still re-enters the
 *     Argus classifier per-call — in-sandbox writes auto-allow (LOW) on both this path and
 *     Claude's post-plan execution, so this is parity, not a weaker gate.
 *   deny → `{approved:false, feedback}` — the model stays in plan mode and keeps planning.
 */
export async function exitPlanModeDecision(
  request: {
    summary?: string
    planContent?: string
    actions?: string[]
    recommendedAction?: string
  },
  onToolRequest: DriverSessionContext['onToolRequest'],
  signal: AbortSignal
): Promise<CopilotExitPlanModeResult> {
  const decision = await onToolRequest(
    'copilot:exit-plan',
    {
      summary: request?.summary,
      planContent: request?.planContent,
      actions: request?.actions,
      recommendedAction: request?.recommendedAction
    },
    { signal }
  )
  if (decision.behavior === 'allow') {
    return {
      approved: true,
      ...(request?.recommendedAction ? { selectedAction: request.recommendedAction } : {})
    }
  }
  return { approved: false, feedback: decision.message }
}

/**
 * Build the `SessionConfig.tools` list from native specs + panel command decls, recording
 * each registration→canonical name into `toolNameMap`. Native tools register as
 * `argus_<name>` (canonical `mcp__argus__<name>`); panel commands as
 * `panel_<pack>_<window>_<cmd>` (canonical `mcp__<pack>__<window>_<cmd>`). A tool whose
 * NATIVE_RISK / panel risk is LOW gets `skipPermission:true` so it bypasses the permission
 * channel exactly like Claude's auto-allow — MEDIUM/HIGH tools stay gated so Argus cards appear.
 */
export function buildCopilotTools(
  ctx: DriverSessionContext,
  toolNameMap: Map<string, string>
): CopilotToolDef[] {
  const tools: CopilotToolDef[] = []
  const handlers = argusToolHandlers(ctx.nativeToolDeps)
  for (const spec of NATIVE_TOOL_SPECS) {
    const registration = `${ARGUS_TOOL_PREFIX}${spec.name}`
    const canonical = `mcp__argus__${spec.name}`
    toolNameMap.set(registration, canonical)
    tools.push({
      name: registration,
      description: spec.description,
      parameters: z.object(spec.schema),
      skipPermission: NATIVE_RISK[canonical]?.action === 'allow',
      handler: (args) => handlers[spec.name](args)
    })
  }
  const dispatch = ctx.dispatchPanelCommand
  if (dispatch) {
    for (const d of ctx.panelCommandDecls) {
      const suffix = `${d.windowId}_${d.cmd}`
      const registration = `panel_${d.packId}_${suffix}`
      toolNameMap.set(registration, `mcp__${d.packId}__${suffix}`)
      const argShape = Object.fromEntries(
        d.args.map((a) => {
          const desc = d.argDescriptions?.[a]
          return [a, desc ? z.string().describe(desc) : z.string()]
        })
      )
      tools.push({
        name: registration,
        description: panelCommandDescription(d),
        parameters: z.object(argShape),
        skipPermission: d.risk === 'low',
        handler: async (a) =>
          JSON.stringify(
            await dispatch(
              d.packId,
              d.windowId,
              d.cmd,
              d.args.map((n) => a[n])
            ),
            null,
            2
          )
      })
    }
  }
  return tools
}

/**
 * `<caseDir>/.claude/skills` when it exists — the per-skill junctions
 * `skillsResolver.materializeSessionSkills` already builds for the Claude driver. Copilot
 * natively supports `SessionConfig.skillDirectories` and loads the same `<name>/SKILL.md`
 * shape unmodified (EVIDENCE §11b, `14-skills.jsonl`: `session.skills_loaded` listed the
 * fixture skill and the model both enumerated and invoked it end-to-end). Returns undefined
 * when the dir is absent so the key is omitted from SessionConfig entirely, rather than
 * sending an empty/missing directory.
 */
export function copilotSkillDirectories(caseDir: string): string[] | undefined {
  const dir = path.join(caseDir, '.claude', 'skills')
  return fs.existsSync(dir) ? [dir] : undefined
}

/**
 * Translate Argus's composed connector servers into Copilot `MCPServerConfig` entries.
 * The composed shapes ({type:"stdio",command,args,env} / {type:"http"|"sse",url,headers})
 * are already field-compatible; the one Copilot-specific requirement is the `tools`
 * allowlist. The SDK's .d.ts claims omitting `tools` "means include all tools" — that is
 * empirically FALSE: without it the server loads `status:"not_configured"` and exposes
 * nothing (EVIDENCE §6c, 16-mcp-transports.jsonl variants A vs D). `["*"]` connects all
 * three transports. An explicit `tools` on a composed entry is preserved.
 */
export function toCopilotMcpServers(
  extra: Record<string, unknown>
): Record<string, unknown> | undefined {
  const entries = Object.entries(extra)
  if (entries.length === 0) return undefined
  return Object.fromEntries(
    entries.map(([id, server]) => [id, { tools: ['*'], ...(server as Record<string, unknown>) }])
  )
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
    authFixHint: 'Sign in to GitHub with `gh auth login`, and ensure your account has Copilot.',
    npmPackage: '@github/copilot',
    updateCommand: 'npm install -g @github/copilot@latest',
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: false, // permission channel cannot carry edited input (EVIDENCE §2)
      costReporting: false, // free tier bills cost:0; costUsd is always null (§5, amendment 10)
      // mcpConnectors omitted (= supported): connector servers forward with a tools:["*"]
      // allowlist, which resolves the §6/§6b "not_configured" failure (EVIDENCE §6c).
      headlessOneShot: true
    },

    isAuthErrorMessage: isCopilotAuthErrorMessage,

    runHeadless: (prompt, opts) => runCopilotHeadless(prompt, opts, clientFactory, config.cliPath),

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

      // Registration-name → canonical `mcp__…` name for native + panel tools, populated by
      // buildCopilotTools and consulted by the permission handler for `custom-tool` requests.
      const toolNameMap = new Map<string, string>()
      const nativeTools = buildCopilotTools(ctx, toolNameMap)

      // Aborts pending approval promises when the session ends/interrupts, so a card left
      // open at teardown rejects instead of dangling.
      const abort = new AbortController()

      // See authTrap.ts: swallow the SDK's leaked auth rejection for this session's
      // lifetime without hijacking unrelated rejections process-wide.
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
        const kind = String(request?.kind ?? 'unknown')
        // Permission-mode short-circuits mirror the Claude SDK (canUseTool is NOT called for
        // auto-approved requests): approve WITHOUT opening an Argus card so behavior parity holds.
        // bypassPermissions → approve everything, genuinely: Claude's bypassPermissions bypasses
        // at the SDK level (no classification at all), so for parity we do NOT run classifyOnly.
        if (ctx.permissionMode === 'bypassPermissions') return { kind: 'approve-once' }
        // acceptEdits suppresses the *ask* for writes (parity with Claude's acceptEdits) but must
        // still honor a *deny*: a write to an out-of-sandbox or read-only-root path is rejected
        // even here (Claude enforces those denies too). classifyOnly runs the SAME risk classifier
        // the ask path uses, WITHOUT a card. Absent (other drivers / older tests) → approve, which
        // preserves the prior unconditional short-circuit.
        if (ctx.permissionMode === 'acceptEdits' && kind === 'write') {
          const synth = synthesizePermissionRequest(request as Record<string, unknown>, toolNameMap)
          const verdict = ctx.classifyOnly?.(synth.name, synth.input)
          if (verdict?.action === 'deny')
            return { kind: 'reject', feedback: verdict.reason ?? 'Denied by sandbox policy' }
          return { kind: 'approve-once' }
        }

        const { name, input } = synthesizePermissionRequest(
          request as Record<string, unknown>,
          toolNameMap
        )
        const decision = await ctx.onToolRequest(name, input, { signal: abort.signal })
        return mapToolDecision(decision)
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
        const skillDirectories = copilotSkillDirectories(ctx.caseDir)
        // Composed connectors forward on BOTH create and resume: resume honoring mcpServers
        // is proven empirically (17-mcp-resume.jsonl) despite upstream sdk#1113 claiming
        // otherwise. Permission requests for these tools arrive as kind:"mcp" and synthesize
        // to `mcp__<server>__<tool>` (§2), so they re-enter the Argus classifier per call.
        const mcpServers = toCopilotMcpServers(ctx.extraMcpServers ?? {})
        const sessionConfig: CopilotSessionConfig = {
          workingDirectory: ctx.caseDir,
          systemMessage: { mode: 'append', content: ctx.systemAppend },
          onPermissionRequest: permissionHandler,
          tools: nativeTools,
          onExitPlanModeRequest: (request) =>
            exitPlanModeDecision(request, ctx.onToolRequest, abort.signal),
          ...(skillDirectories ? { skillDirectories } : {}),
          ...(mcpServers ? { mcpServers } : {})
        }
        session = ctx.resumeCursor
          ? await client.resumeSession(ctx.resumeCursor, sessionConfig)
          : await client.createSession(sessionConfig)

        // Cursor = the Copilot sessionId (a stable UUID, unchanged across resume). Known
        // synchronously once the session exists (EVIDENCE §10, plan amendment 5).
        ctx.onCursor(session.sessionId)
        session.on((event) => queue.push(event))

        // Plan mode is engaged after creation via the mode RPC (EVIDENCE §9). Attached after
        // the event listener so the mode_changed event is observed. Optional-chained so
        // scripted fakes without an rpc surface no-op; a real failure surfaces as fatal.
        if (ctx.permissionMode === 'plan') {
          await session.rpc?.mode?.set?.({ mode: 'plan' })
        }

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
          abort.abort()
          await session?.abort().catch(() => undefined)
        },
        end(): void {
          if (ended) return
          ended = true
          abort.abort() // reject any approval card still pending at teardown
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
      const timeoutMs = config2.timeoutMs ?? 10000
      let client: CopilotClientLike | null = null
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      // The probe boots its own runtime, so it needs the same rejection trap a session holds:
      // a runtime that fails to spawn leaks its write rejections from inside the SDK, and the
      // probe is periodic — untrapped, that floods the log on every tick.
      const releaseTrap = acquireAuthRejectionTrap()
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
        const c = client
        // The runtime boot + auth query is bounded: a wedged `start()` (e.g. a hung child
        // transport) must not hang the probe forever. Race it against timeoutMs.
        const probe = (async () => {
          await c.start() // boot the runtime transport before querying auth
          const status = await c.getAuthStatus()
          const version = await c
            .getStatus()
            .then((s) => s.version)
            .catch(() => undefined)
          return { status, version }
        })()
        probe.catch(() => undefined) // never leak an unhandled rejection if it settles post-timeout
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            reject(new Error('copilot-probe-timeout'))
          }, timeoutMs)
          timer.unref?.()
        })
        const { status, version } = await Promise.race([probe, timeout])
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
        if (timedOut) return { ok: false, detail: `Copilot probe timed out after ${timeoutMs}ms` }
        // A missing/unspawnable runtime (ENOENT / spawn-shaped) gets an actionable detail;
        // everything else surfaces the raw message unchanged.
        const e = err as NodeJS.ErrnoException
        const spawnShaped = e?.code === 'ENOENT' || /ENOENT|spawn/i.test(e?.message ?? '')
        return {
          ok: false,
          detail: spawnShaped
            ? 'Copilot runtime not found — check the CLI path or reinstall @github/copilot-sdk'
            : (e?.message ?? String(err))
        }
      } finally {
        if (timer) clearTimeout(timer)
        // Always reap the probe client on BOTH branches; on a wedged start() the graceful stop
        // may not respond, so forceStop is the fallback — never leave an orphaned runtime.
        await client?.stop().catch(() => client?.forceStop().catch(() => undefined))
        releaseTrap()
      }
    }
  }
}
