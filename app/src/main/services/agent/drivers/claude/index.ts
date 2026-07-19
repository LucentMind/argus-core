import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent } from '../../../../../shared/agent-events'
import { PERMISSION_MODES } from '../../../../../shared/settings'
import { AsyncQueue } from '../../asyncQueue'
import { CLAUDE_TOOL_TAXONOMY } from '../../risk'
import { createArgusMcpServer } from '../../nativeTools'
import { buildPanelCommandServers } from '../../panelCommands'
import { probeAuth } from './probe'
import { resolveClaudeCliPath } from './cliPath'
import { qualifySkill, skillPluginRoot } from '../../skillsResolver'
import type {
  AgentDriver,
  DriverSession,
  DriverSessionContext,
  ProbeAuthResult,
  TurnResult
} from '../../driver'
import { normalizeSdkMessage } from './normalize'
import { runClaudeHeadless } from './headless'

// Relocated from session.ts (Task 4 removed the copies there); registry.ts and existing
// tests import these from the driver module.
export type QueryHandle = AsyncIterable<unknown> & { interrupt(): Promise<void> }
export type CreateQueryFn = (args: {
  prompt: AsyncIterable<unknown>
  options: Record<string, unknown>
}) => QueryHandle

// This module owns defaultCreateQuery; registry.ts consumes it via createClaudeDriver().
const defaultCreateQuery: CreateQueryFn = (args) =>
  query({ prompt: args.prompt as never, options: args.options as never }) as never

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Auth-shaped failure detection (spec §5), calibrated against the real CLI (verified
 * 2026-07-16 — see .superpowers/sdd/auth-shape-evidence.md). Both real auth failures come
 * back as `subtype: 'success'` with `is_error: true` — the SDK does not use an error
 * subtype for them, so `is_error` is the ONLY reliable discriminator:
 *   - not logged in:      result: "Not logged in · Please run /login", api_error_status: null
 *   - invalid/expired key: result: "Invalid API key · Fix external API key", api_error_status: 401
 * `api_error_status` is a structured 401 signal, but it's populated ONLY for the bad-key
 * mode — the not-logged-in mode has to be caught by text. This regex is that fallback, and
 * (like the structured check) it is matched ONLY against error-flagged results and thrown
 * transport errors — never assistant text — so a user prompt or model reply that merely
 * mentions logging in can never trip it. Deliberately excludes bare "401"/"unauthorized":
 * neither appears in a real auth message, and unqualified they'd let an unrelated
 * connector's 401 (e.g. an Atlassian call surfacing as a thrown transport error) wrongly
 * mark the user's Claude session logged out.
 */
const AUTH_FAILURE_RE = /not logged in|please run \/login|invalid api key|authentication_error/i

export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE_RE.test(text)
}

export function createClaudeDriver(createQuery: CreateQueryFn = defaultCreateQuery): AgentDriver {
  return {
    kind: 'claude-agent-sdk',
    toolTaxonomy: CLAUDE_TOOL_TAXONOMY,
    authFixHint: 'Log in with `claude login` (or set ANTHROPIC_API_KEY).',
    npmPackage: '@anthropic-ai/claude-code',
    updateCommand: 'npm install -g @anthropic-ai/claude-code@latest',
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: true,
      costReporting: true,
      headlessOneShot: true
    },

    runHeadless: (prompt, opts) => runClaudeHeadless(prompt, opts, createQuery),

    createSession(ctx: DriverSessionContext): DriverSession {
      const promptQueue = new AsyncQueue<unknown>()

      // A user-configured path wins; otherwise steer a packaged build off the unspawnable
      // in-asar binary (see resolveClaudeCliPath). Null in dev — the SDK resolves itself.
      const cliPath = ctx.cliPath ?? resolveClaudeCliPath()

      // Single source of truth for "is this a resume?". It gates the SDK's `resume`
      // option below AND the `resumed` flag on session.started — they must never
      // disagree. A non-UUID cursor is rejected, so the SDK starts fresh and the flag
      // must say so. Observability depends on this: the Langfuse exporter opens a new
      // trace root for a fresh session and only a marker for a resumed one, so a
      // hardcoded `false` here made every restart mint a second root.
      const isResume = Boolean(ctx.resumeCursor && UUID_RE.test(ctx.resumeCursor))

      // Options bag: relocated from session.ts:168-211; the DriverSessionContext
      // fields substitute for the SessionDeps/agentOptions values the harness used to
      // read directly (systemAppend, extraMcpServers, nativeToolDeps, onToolRequest).
      const handle = createQuery({
        prompt: promptQueue,
        options: {
          cwd: ctx.caseDir,
          additionalDirectories: [...ctx.additionalDirectories],
          // `<caseDir>/.claude` is a local plugin root (manifest written by
          // materializeSessionSkills), which namespaces our skills as `argus:<name>`.
          plugins: [{ type: 'local', path: skillPluginRoot(ctx.caseDir) }],
          // Always sent, empty included: omitting `skills` is not "skills off" — the SDK
          // leaves the CLI's own discover-everything default in place, which pulls in the
          // .claude/skills of every additionalDirectory (i.e. of linked case workspaces).
          // Qualified, because a BARE name matches every skill so named — including a
          // linked workspace's collider (verified: one bare entry loaded two skills).
          //
          // KNOWN GAP — this bounds the MAIN SESSION ONLY. A subagent spawned via Task
          // re-derives its own skill listing and sees everything discovery finds, linked
          // workspaces included (measured 2026-07-19: main 2 skills, subagent 52 with all
          // of analyze-logcat/-dlt/-recording/doctor/rca). That matters because a linked
          // repo is an investigation artifact — often someone else's — so its SKILL.md is
          // untrusted text a subagent would load as instructions, with no approval card.
          //
          // Deliberately left open; do not "fix" it with the obvious moves, all measured:
          //   - AgentDefinition.skills is PRELOAD, not a filter — no restricting effect.
          //   - settingSources:['project'] drops user-level plugins (52→34) but the
          //     workspace's own skills still load.
          //   - disallowedTools:['Skill'] in an `agents` entry works ONLY for a custom type
          //     name; overriding a built-in (general-purpose) is ignored, and the model can
          //     always fall back to a built-in, so it is escapable rather than contained.
          // The only reliable containment is denying Task outright (disallowedTools:['Task'],
          // verified: no subagent spawns) — a deliberate product call, not an oversight.
          skills: ctx.skills.map(qualifySkill),
          // Load PROJECT settings only. The main session is already bounded by `skills`
          // above, but a subagent re-derives its own listing and measured 52 skills — 36 of
          // them the operator's personal Claude Code toolkit (superpowers, revealjs,
          // web-asset-generator, …), which is noise for defect analysis. Dropping
          // 'user'/'local' removes those (52→34) while KEEPING the linked repo's domain
          // log-parsers, which are useful to a subagent.
          //
          // 'project' is mandatory: without it the per-case CLAUDE.md — citation rules and
          // the linked-workspace list — stops loading. Do not "tighten" this to []; that
          // also drops the repo skills (52→18) but silently takes the case briefing with
          // it, unless CLAUDE.md is first folded into `systemAppend`.
          //
          // Side effect, deliberate: Argus no longer inherits the operator's personal
          // ~/.claude permission allowlists, so tool calls they had pre-approved globally
          // now reach Argus's own approval pipeline instead of being auto-allowed.
          settingSources: ['project'],
          includePartialMessages: true,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: ctx.systemAppend
          },
          ...(ctx.model ? { model: ctx.model } : {}),
          ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
          ...(ctx.permissionMode && ctx.permissionMode !== 'default'
            ? { permissionMode: ctx.permissionMode }
            : {}),
          mcpServers: {
            ...ctx.extraMcpServers,
            ...(ctx.dispatchPanelCommand
              ? buildPanelCommandServers(ctx.panelCommandDecls, ctx.dispatchPanelCommand)
              : {}),
            argus: createArgusMcpServer(ctx.nativeToolDeps)
          },
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            opts: { signal: AbortSignal }
          ) => ctx.onToolRequest(toolName, input, opts),
          ...(isResume ? { resume: ctx.resumeCursor } : {})
        }
      })

      // Stream state (relocated from CaseSession fields).
      let currentModel: string | null = null
      const toolNames = new Map<string, string>() // toolCallId → name

      // Relocated from session.ts:515-536 (updateCursor). The SQL UPDATE is replaced by
      // ctx.onCursor(session_id); the durability conditions (system/init or result +
      // UUID check) are preserved exactly — behavior preservation wins over generality.
      const updateCursor = (msg: {
        type?: string
        subtype?: string
        session_id?: string
        model?: string
        fallback_model?: string
      }): void => {
        if (msg.type === 'system' && msg.subtype === 'init' && msg.model) {
          currentModel = String(msg.model)
        }
        // SDKModelRefusalFallbackMessage: a refusal made the model swap persistent for the
        // rest of the session, without re-emitting 'init'. Track it so later turns whose
        // result lacks modelUsage still fall back to the right model.
        if (
          msg.type === 'system' &&
          msg.subtype === 'model_refusal_fallback' &&
          msg.fallback_model
        ) {
          currentModel = String(msg.fallback_model)
        }
        const durable = (msg.type === 'system' && msg.subtype === 'init') || msg.type === 'result'
        if (!durable || !msg.session_id || !UUID_RE.test(msg.session_id)) return
        ctx.onCursor(msg.session_id)
      }

      // Relocated from session.ts:542-559 (resolveTurnModel). The result message's
      // modelUsage is the authoritative per-turn record of which model(s) actually ran.
      // Pick the model with the greatest input+output token usage; fall back to the
      // last-known model (init, or a model_refusal_fallback swap) if absent/empty.
      const resolveTurnModel = (msg: {
        modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>
      }): string | null => {
        const usage = msg.modelUsage
        if (usage && typeof usage === 'object') {
          let best: string | null = null
          let bestTotal = -1
          for (const [model, u] of Object.entries(usage)) {
            const total = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0)
            if (total > bestTotal) {
              bestTotal = total
              best = model
            }
          }
          if (best != null) return best
        }
        return currentModel
      }

      // Relocated from session.ts:562-595 (handleResult). Extraction only — the SQL
      // writes + onAuthFailure/onAuthVerified dispatch moved to the harness (Task 4),
      // which acts on the returned TurnResult. The auth predicate is preserved verbatim:
      // is_error is the ONLY discriminator (subtype is 'success' in both failure modes);
      // api_error_status is 401 for a bad key but null when simply not logged in, so text
      // is still needed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const extractTurnResult = (msg: any): TurnResult => ({
        isError: Boolean(msg.is_error),
        inputTokens: msg.usage?.input_tokens ?? null,
        outputTokens: msg.usage?.output_tokens ?? null,
        costUsd: msg.total_cost_usd ?? null,
        durationMs: msg.duration_ms ?? null,
        model: resolveTurnModel(msg),
        authFailure: Boolean(
          msg.is_error && (msg.api_error_status === 401 || isAuthFailure(String(msg.result ?? '')))
        )
      })

      // Stream loop: relocated from session.ts:597-615 (consume). Errors thrown by the
      // underlying query stream propagate out of events() — the harness (Task 4) handles
      // session.error emission; the driver deliberately does NOT swallow them.
      async function* events(): AsyncIterable<AgentEvent> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const msg of handle as AsyncIterable<any>) {
          updateCursor(msg)
          if (msg.type === 'result') ctx.onTurnResult(extractTurnResult(msg))
          for (const ev of normalizeSdkMessage(msg, ctx.eventCtx())) {
            // normalize.ts cannot know whether this session resumed — NormalizeCtx
            // carries no cursor — so it emits a placeholder that is corrected here,
            // the same way tool names are backfilled below.
            if (ev.type === 'session.started') {
              ev.payload.resumed = isResume
            }
            if (ev.type === 'tool.call.started') {
              toolNames.set(ev.payload.toolCallId, ev.payload.name)
            }
            if (ev.type === 'tool.call.completed' && !ev.payload.name) {
              ev.payload.name = toolNames.get(ev.payload.toolCallId) ?? ''
            }
            yield ev
          }
        }
      }

      return {
        events,
        // Relocated from session.ts:269-274 (SDK user envelope) verbatim.
        send(text: string): void {
          promptQueue.push({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text }] },
            parent_tool_use_id: null,
            session_id: ''
          })
        },
        async interrupt(): Promise<void> {
          await handle.interrupt().catch(() => undefined)
        },
        end(): void {
          promptQueue.end()
        }
      }
    },

    // Delegates to probe.ts (colocated Task 6). AuthStatus carries a few more optional
    // fields (email/subscription/version) than the driver-agnostic core of
    // ProbeAuthResult — passed through as-is (not folded into detail) so index.ts call
    // sites see exactly what the pre-driver probe gave them: HealthService's `detail`
    // text is unchanged, and AuthCache/the renderer still get email/subscription/version
    // as distinct fields.
    async probeAuth(config: { cliPath?: string; timeoutMs?: number }): Promise<ProbeAuthResult> {
      const st = await probeAuth(createQuery, config)
      return {
        ok: st.ok,
        detail: st.detail,
        ...(st.email ? { email: st.email } : {}),
        ...(st.subscription ? { subscription: st.subscription } : {}),
        ...(st.version ? { version: st.version } : {})
      }
    }
  }
}
