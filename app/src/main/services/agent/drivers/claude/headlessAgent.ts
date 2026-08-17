import {
  abortRacer,
  type HeadlessAgentOpts,
  type HeadlessAgentResult,
  type HeadlessUsage,
  type TrajectoryEntry
} from '../../driver'
import type { CreateQueryFn } from '.'
import { claudeSpawnEnv, resolveClaudeCliPath } from './cliPath'
import { agentScratchCwd } from '../../scratchCwd'
import { AsyncQueue } from '../../asyncQueue'

/** Sent once, when the observed assistant turn count reaches `maxIterations` — the design
 *  spec's "on either limit the session is asked for its final answer". `maxTurns` is passed
 *  as `maxIterations + 1` (below) so the SDK has headroom to actually run this turn instead
 *  of cutting the session off at the same count that triggered the nudge. */
const BUDGET_EXHAUSTED_NUDGE =
  'Budget exhausted — return your final fenced json block now, based on what you have.'

function userMessage(text: string): unknown {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: ''
  }
}

/** UTF-8 byte length of a `tool_result` block's `content`, which is either a plain string or
 *  an array of content blocks (image/text) — stringified first in the latter case. Used only
 *  for `TrajectoryEntry.resultBytes`, an audit figure, so an approximation for the array case
 *  is acceptable. */
function contentByteLength(content: unknown): number {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
  return Buffer.byteLength(text, 'utf8')
}

/** Mutable accumulator the collector fills in as the stream runs, and the ONLY thing the
 *  timeout race needs a reference to — so a wall-clock cutoff can still harvest whatever was
 *  collected up to that instant instead of discarding it (see `runClaudeHeadlessAgent`). */
interface CollectorState {
  last: string
  turnCount: number
  toolCallCount: number
  trajectory: TrajectoryEntry[]
  usage?: HeadlessUsage
}

function newState(): CollectorState {
  return { last: '', turnCount: 0, toolCallCount: 0, trajectory: [] }
}

function toResult(state: CollectorState, capHit?: 'iterations' | 'timeout'): HeadlessAgentResult {
  return {
    text: state.last,
    usage: state.usage,
    turnCount: state.turnCount,
    toolCallCount: state.toolCallCount,
    trajectory: state.trajectory,
    ...(capHit ? { capHit } : {})
  }
}

/** Usage extraction identical to headless.ts's `collectAssistant`: typeof-guarded spreads,
 *  never a fabricated `0`. Both `SDKResultSuccess` and `SDKResultError` (sdk.d.ts) carry the
 *  same `usage`/`total_cost_usd` shape, so this runs on either result subtype. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractUsage(msg: any, started: number): HeadlessUsage {
  return {
    ...(typeof msg.usage?.input_tokens === 'number' ? { inputTokens: msg.usage.input_tokens } : {}),
    ...(typeof msg.usage?.output_tokens === 'number'
      ? { outputTokens: msg.usage.output_tokens }
      : {}),
    ...(typeof msg.total_cost_usd === 'number' ? { costUsd: msg.total_cost_usd } : {}),
    durationMs: Date.now() - started
  }
}

/**
 * Walks the stream of an AGENTIC run, mutating `state` as it goes (so a concurrent timeout can
 * harvest a snapshot — see `runClaudeHeadlessAgent`). Every `assistant` message is one turn.
 * Within a turn, `tool_use` blocks are recorded into the trajectory (truncated JSON args) and
 * counted; `text` blocks update the running "last non-empty assistant text". A matching
 * `tool_result` block on a later `user`-role message backfills that trajectory entry's
 * `resultBytes`, keyed by `tool_use_id`.
 *
 * When the observed turn count reaches `maxIterations`, pushes the budget-exhausted nudge onto
 * `promptQueue` exactly once (the stream is held open by the queue, same as `runHeadless`'s
 * single-shot generator, but here it can accept more input).
 *
 * On the terminal `result` message: a `success` subtype returns cleanly, no `capHit`. A
 * non-success subtype (`SDKResultError` — `error_max_turns`, `error_during_execution`,
 * `error_max_budget_usd`, `error_max_structured_output_retries`) means the SDK cut the run off
 * before a clean end; if anything was collected, that is harvested and returned with
 * `capHit: 'iterations'` (the design spec's "either limit" bucket — Task 11 has no way to
 * distinguish which specific SDK-side cap fired, and none of them are Task 11's own
 * wall-clock `timeoutMs`, so they all land under the same label). Only a plain error subtype
 * with NOTHING collected still throws, matching `runHeadless`'s existing failure behavior.
 */
async function collectAgentRun(
  q: AsyncIterable<unknown>,
  promptQueue: AsyncQueue<unknown>,
  state: CollectorState,
  maxIterations: number,
  started: number
): Promise<HeadlessAgentResult> {
  let nudged = false
  const trajectoryIndexByToolUseId = new Map<string, number>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const msg of q as AsyncIterable<any>) {
    if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
      state.turnCount++
      const blocks = msg.message.content as Array<{
        type?: string
        text?: unknown
        name?: unknown
        input?: unknown
        id?: unknown
      }>
      const t = blocks
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('')
      if (t.trim()) state.last = t
      for (const block of blocks) {
        if (block?.type === 'tool_use') {
          state.toolCallCount++
          state.trajectory.push({
            turn: state.turnCount,
            tool: String(block.name ?? ''),
            argsSummary: JSON.stringify(block.input ?? {}).slice(0, 200)
          })
          if (block.id != null) {
            trajectoryIndexByToolUseId.set(String(block.id), state.trajectory.length - 1)
          }
        }
      }
      if (state.turnCount === maxIterations && !nudged) {
        nudged = true
        promptQueue.push(userMessage(BUDGET_EXHAUSTED_NUDGE))
      }
    }
    if (msg?.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content as Array<{
        type?: string
        tool_use_id?: unknown
        content?: unknown
      }>) {
        if (block?.type !== 'tool_result' || block.tool_use_id == null) continue
        const idx = trajectoryIndexByToolUseId.get(String(block.tool_use_id))
        if (idx !== undefined) {
          state.trajectory[idx] = {
            ...state.trajectory[idx],
            resultBytes: contentByteLength(block.content)
          }
        }
      }
    }
    if (msg?.type === 'result') {
      // Snapshot BEFORE num_turns below can overwrite the client count — this is what
      // decides "did we actually collect anything to harvest" for a non-success subtype.
      const hadAnyContent =
        state.turnCount > 0 || state.trajectory.length > 0 || Boolean(state.last)
      state.usage = extractUsage(msg, started)
      // Prefer the SDK's own authoritative turn count when the result message reports one.
      if (typeof msg.num_turns === 'number') state.turnCount = msg.num_turns
      if (msg.subtype && msg.subtype !== 'success') {
        if (!hadAnyContent) throw new Error(`headless agent run failed: ${String(msg.subtype)}`)
        return toResult(state, 'iterations')
      }
      return toResult(state)
    }
  }
  return toResult(state)
}

/**
 * Agentic headless one-shot: multi-turn, tools/MCP enabled, no case, no sessions row, no
 * mirror. Mirrors `runClaudeHeadless` (headless.ts) in its lifecycle plumbing — timeout/abort
 * race, `q.interrupt()` in `finally`, cliPath fallback — but diverges in two ways `headless.ts`
 * doesn't need:
 *
 * - The prompt is a controllable `AsyncQueue`, not a single-shot generator, so the
 *   budget-exhaustion nudge (see `collectAgentRun`) can be pushed mid-run.
 * - A budget cutoff HARVESTS instead of throwing: a non-success `result` subtype with
 *   something collected, or this function's own `timeoutMs` elapsing, both resolve with
 *   `capHit` set rather than rejecting — see `HeadlessAgentResult.capHit`'s doc. An explicit
 *   `signal` abort still rejects (`abortRacer`) — that is an external cancellation, not one of
 *   the two budgets this spec sentence covers, and the caller (`DistillQueue.cancel`) needs to
 *   tell "cancelled" apart from "ran out of budget".
 */
export async function runClaudeHeadlessAgent(
  prompt: string,
  opts: HeadlessAgentOpts,
  createQuery: CreateQueryFn,
  resolveCliPath: () => string | null = resolveClaudeCliPath
): Promise<HeadlessAgentResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const started = Date.now()
  const promptQueue = new AsyncQueue<unknown>()
  promptQueue.push(userMessage(prompt))
  const state = newState()
  let q: ReturnType<CreateQueryFn> | null = null
  let timer: NodeJS.Timeout | null = null
  try {
    const cliPath = opts.cliPath ?? resolveCliPath() ?? undefined
    q = createQuery({
      prompt: promptQueue,
      options: {
        // Same containment as runHeadless — see its comment on cwd.
        cwd: agentScratchCwd(),
        // +1 headroom: the nudge above fires exactly AT maxIterations, so the SDK needs one
        // more turn available to actually answer it rather than being cut off at the same
        // count that triggered the ask.
        maxTurns: opts.maxIterations + 1,
        // `tools` scopes the BUILT-IN tool set (Bash/Read/Edit/...) per sdk.d.ts's own doc
        // ("base set of available built-in tools") — it does not affect MCP-server-provided
        // tools, which is a separate source (`mcpServers` below). A distillation run has no
        // business touching the filesystem/shell outside its MCP world-model tools, so this
        // is the built-ins half of the whitelist; `allowedTools`/`canUseTool` below are the
        // MCP-tool half.
        tools: [],
        // Auto-approves the whitelist so the run doesn't stall on a permission prompt with no
        // human to answer it — but `allowedTools` ONLY auto-approves, it does not restrict
        // (sdk.d.ts: "To restrict which tools are available, use the `tools` option instead" —
        // which, per the comment above, only reaches built-ins, not MCP tools). `canUseTool`
        // below is the actual gate for the MCP surface.
        allowedTools: opts.allowedTools,
        // Defense in depth: without this, a model emitting a tool_use for an MCP tool outside
        // `allowedTools` would still execute (canUseTool defaults to allow when absent). Same
        // signature/shape claude/index.ts's own canUseTool uses (toolName, input, { toolUseID
        // }) => Promise<PermissionResult>; `updatedInput` echoes the input back unchanged,
        // matching the SDK's own PermissionResult contract for an 'allow' decision.
        canUseTool: async (toolName: string, input: Record<string, unknown>) =>
          opts.allowedTools.includes(toolName)
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'not available in distillation' },
        mcpServers: { argus: opts.mcpServer },
        env: claudeSpawnEnv(),
        ...(opts.model ? { model: opts.model } : {}),
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {})
      }
    })
    const result = await Promise.race([
      collectAgentRun(q, promptQueue, state, opts.maxIterations, started),
      new Promise<HeadlessAgentResult>((resolve) => {
        // Harvest, don't throw — see the doc comment above and HeadlessAgentResult.capHit.
        timer = setTimeout(() => resolve(toResult(state, 'timeout')), timeoutMs)
      }),
      abortRacer(opts.signal)
    ])
    // An empty text is only a real failure when nothing explains it; capHit already IS that
    // explanation (a harvested empty-text return is deliberate — see capHit's doc).
    if (!result.capHit && !result.text.trim())
      throw new Error('headless agent run returned no text')
    return result
  } finally {
    if (timer) clearTimeout(timer)
    promptQueue.end()
    await q?.interrupt().catch(() => undefined)
  }
}
