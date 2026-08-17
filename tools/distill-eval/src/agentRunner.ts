import { z } from 'zod'
import {
  createSdkMcpServer,
  query,
  tool,
  type McpSdkServerConfigWithInstance,
  type PermissionResult
} from '@anthropic-ai/claude-agent-sdk'
import type { DistillWorld } from '../../../app/src/shared/distill'
import { agentScratchCwd } from '../../../app/src/main/services/agent/scratchCwd'
// Harness-safe: cliPath.ts imports only node:path and drivers/asar.ts (which imports nothing) —
// no electron, no asar runtime. `claudeSpawnEnv` is the same env the app's three spawn sites use.
import { claudeSpawnEnv } from '../../../app/src/main/services/agent/drivers/claude/cliPath'
import {
  listSessionsTool,
  readTranscript,
  searchTranscript,
  DISTILL_ALLOWED_TOOLS,
  DISTILL_MAX_ITERATIONS,
  DISTILL_TOOL_DESCRIPTORS
} from '../../../app/src/main/services/distill/worldTools'

/**
 * A replay of one distill job. Agentic, not one-shot: the v2 distiller reaches for transcripts
 * through tools, so replaying a candidate contract means running the same loop over the SAME
 * frozen world the live job saw (`inputSnapshot.world`).
 *
 * `world === null` is a DEGRADED replay — a pre-v2 corpus line that has no world key. The tools
 * stay REGISTERED (their descriptions are hashed prompt surface, and the contract's tool guidance
 * must parse identically either way) but every call answers `REPLAY_WORLD_UNAVAILABLE`.
 */
export type AgentRunner = (
  prompt: string,
  world: DistillWorld | null
) => Promise<AgentReplayResult>

/**
 * What one agent replay produced. `capSubtype` is the SDK's terminal non-success `result.subtype`
 * (`error_max_turns`, `error_during_execution`, `error_max_budget_usd`, …) when the run was cut
 * off instead of ending cleanly. It must ride out of the runner, not be swallowed: the app FAILS
 * a capped distill job rather than parsing its text (caseDistiller.ts's capHit handling — the
 * refusal to parse happens there, not in queue.ts), so a harness that graded the same text would
 * score a candidate on output the product would have rejected.
 */
export interface AgentReplayResult {
  text: string
  capSubtype?: string
}

/** The distinguished answer every world tool gives when there is no world to serve. */
export const REPLAY_WORLD_UNAVAILABLE =
  'transcripts unavailable for this replay (pre-v2 corpus line)'

/**
 * PTC (`run_tool_script`) is a live-app capability: it needs the Electron-side script service
 * (`app/src/main/services/ptc/run.ts`), whose assumptions the harness cannot satisfy. The tool
 * stays registered — dropping it would change the advertised tool surface, i.e. the prompt — but
 * always answers this, telling the agent to sweep with the direct tools instead. Replays of a
 * job that used scripts therefore approximate, not reproduce, the live trajectory; final items
 * are what the judge grades, so this is an accepted approximation (see README).
 */
export const REPLAY_PTC_UNAVAILABLE =
  'run_tool_script unavailable for this replay (the harness cannot run the app-side script service) — use list_sessions/read_transcript/search_transcript directly instead'

const descByName = Object.fromEntries(DISTILL_TOOL_DESCRIPTORS.map((d) => [d.name, d.description]))

function asText(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text }] }
}

/**
 * The same in-process MCP server the app builds (`distill/mcp.ts`), over an exported world
 * instead of a live-enqueued one, with the PTC tool stubbed. Descriptions come from
 * `DISTILL_TOOL_DESCRIPTORS` verbatim so the replayed tool surface matches the hashed one.
 */
export function createReplayMcpServer(world: DistillWorld | null): McpSdkServerConfigWithInstance {
  const served = <T>(fn: (w: DistillWorld) => T): { content: [{ type: 'text'; text: string }] } =>
    world === null ? asText(REPLAY_WORLD_UNAVAILABLE) : asText(JSON.stringify(fn(world)))

  return createSdkMcpServer({
    name: 'argus',
    version: '1.0.0',
    tools: [
      tool('list_sessions', descByName.list_sessions, {}, async () => served(listSessionsTool)),
      tool(
        'read_transcript',
        descByName.read_transcript,
        {
          session_id: z.number(),
          offset: z.number().optional(),
          limit: z.number().optional(),
          roles: z.array(z.string()).optional()
        },
        async (a) => served((w) => readTranscript(w, a))
      ),
      tool(
        'search_transcript',
        descByName.search_transcript,
        { query: z.string(), roles: z.array(z.string()).optional() },
        async (a) => served((w) => searchTranscript(w, a))
      ),
      tool('run_tool_script', descByName.run_tool_script, { script: z.string() }, async () =>
        asText(REPLAY_PTC_UNAVAILABLE)
      )
    ]
  })
}

/** The options `claudeAgentRunner` hands the SDK — a typed subset of the SDK's `Options`, so a
 *  test can assert the containment wiring without a live CLI. */
export interface ReplayQueryOptions {
  cwd: string
  maxTurns: number
  tools: string[]
  allowedTools: string[]
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>
  mcpServers: { argus: McpSdkServerConfigWithInstance }
  env: NodeJS.ProcessEnv
  model?: string
}

export interface ReplayQuery extends AsyncIterable<unknown> {
  /** the SDK's `Query.interrupt` resolves with a control response; the harness only awaits it */
  interrupt?: () => Promise<unknown>
}

/** Injection seam for tests: the only path that would spawn the SDK's bundled CLI. */
export type CreateQueryFn = (args: { prompt: string; options: ReplayQueryOptions }) => ReplayQuery

const defaultCreateQuery: CreateQueryFn = (args) =>
  query({ prompt: args.prompt, options: args.options })

/**
 * Walks an agentic run and keeps the last non-empty assistant text — the same idiom as the app's
 * `collectAgentRun` (headlessAgent.ts), minus the trajectory/usage bookkeeping and the
 * budget-exhaustion nudge: the harness grades final items, and its prompt is a plain string
 * rather than a pushable queue.
 *
 * A non-success terminal subtype is HARVESTED, never swallowed and never thrown: it comes back as
 * `capSubtype` so `replayCase` can mark the case and the report can name it. Only a clean
 * (success) run that produced no text at all is an outright error — that is a broken replay, not
 * a capped one.
 */
async function collectRun(q: ReplayQuery): Promise<AgentReplayResult> {
  let last = ''
  let capSubtype: string | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const msg of q as AsyncIterable<any>) {
    if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
      const text = (msg.message.content as { type?: string; text?: unknown }[])
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('')
      if (text.trim()) last = text
    }
    if (msg?.type === 'result') {
      if (msg.subtype && msg.subtype !== 'success') capSubtype = String(msg.subtype)
      break
    }
  }
  if (!last.trim() && !capSubtype) throw new Error('agent replay returned no text')
  return { text: last, ...(capSubtype ? { capSubtype } : {}) }
}

/**
 * Default agent runner: drives the Claude Agent SDK headless over the frozen world. Option
 * shapes mirror the app's `runClaudeHeadlessAgent` deliberately — `tools: []` locks out the
 * built-ins, `allowedTools` auto-approves only the mcp__argus__ surface, and `canUseTool` is the
 * actual gate (allowedTools only auto-approves, it does not restrict).
 */
export function claudeAgentRunner(
  model?: string,
  createQuery: CreateQueryFn = defaultCreateQuery
): AgentRunner {
  return async (prompt, world) => {
    const options: ReplayQueryOptions = {
      // An empty, non-git, non-TCC directory: the CLI walks its cwd at boot, and the repo root
      // (or a long-lived %TEMP%) makes that walk slow. Same helper the app uses.
      cwd: agentScratchCwd(),
      maxTurns: DISTILL_MAX_ITERATIONS,
      tools: [],
      allowedTools: DISTILL_ALLOWED_TOOLS,
      canUseTool: async (toolName, input) =>
        DISTILL_ALLOWED_TOOLS.includes(toolName)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'not available in distillation replay' },
      mcpServers: { argus: createReplayMcpServer(world) },
      // Same env as every app-side Claude spawn: auto-memory OFF. The CLI's own memory subsystem
      // defaults ON and both READS and writes under ~/.claude/projects/<cwd>/memory — in a replay
      // that would inject unrelated memories into the distill prompt, i.e. the candidate contract
      // would be graded on an input the live job never had. See claudeSpawnEnv's doc (cliPath.ts);
      // the process.env spread is load-bearing (the SDK REPLACES the subprocess env).
      env: claudeSpawnEnv(),
      ...(model ? { model } : {})
    }
    const q = createQuery({ prompt, options })
    try {
      return await collectRun(q)
    } finally {
      await q.interrupt?.().catch(() => undefined)
    }
  }
}
