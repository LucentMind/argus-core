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

// Same "one message, then hold the stream open" idiom as headless.ts — see its comment.
async function* oneMessage(text: string): AsyncGenerator<unknown> {
  yield {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: ''
  }
  await new Promise(() => undefined)
}

/**
 * Walks the stream of an AGENTIC run: every `assistant` message is one turn. Within a turn,
 * `tool_use` blocks are recorded into the trajectory (truncated JSON args — enough to audit
 * a run without unbounded growth) and counted; `text` blocks update the running "last
 * non-empty assistant text", which becomes the run's parsed surface. Usage extraction on the
 * terminal `result` message is identical to headless.ts's `collectAssistant`: typeof-guarded
 * spreads, never a fabricated `0`.
 */
async function collectAgentRun(
  q: AsyncIterable<unknown>,
  started: number
): Promise<HeadlessAgentResult> {
  let last = ''
  let turnCount = 0
  let toolCallCount = 0
  const trajectory: TrajectoryEntry[] = []
  let usage: HeadlessUsage | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const msg of q as AsyncIterable<any>) {
    if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
      turnCount++
      const blocks = msg.message.content as Array<{
        type?: string
        text?: unknown
        name?: unknown
        input?: unknown
      }>
      const t = blocks
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('')
      if (t.trim()) last = t
      for (const block of blocks) {
        if (block?.type === 'tool_use') {
          toolCallCount++
          trajectory.push({
            turn: turnCount,
            tool: String(block.name ?? ''),
            argsSummary: JSON.stringify(block.input ?? {}).slice(0, 200)
          })
        }
      }
    }
    if (msg?.type === 'result') {
      if (msg.subtype && msg.subtype !== 'success') {
        throw new Error(`headless agent run failed: ${String(msg.subtype)}`)
      }
      usage = {
        ...(typeof msg.usage?.input_tokens === 'number'
          ? { inputTokens: msg.usage.input_tokens }
          : {}),
        ...(typeof msg.usage?.output_tokens === 'number'
          ? { outputTokens: msg.usage.output_tokens }
          : {}),
        ...(typeof msg.total_cost_usd === 'number' ? { costUsd: msg.total_cost_usd } : {}),
        durationMs: Date.now() - started
      }
      break
    }
  }
  return { text: last, usage, turnCount, toolCallCount, trajectory }
}

/**
 * Agentic headless one-shot: multi-turn, tools/MCP enabled, no case, no sessions row, no
 * mirror. Throws on failure. Mirrors `runClaudeHeadless` (headless.ts) in every respect
 * except the options bag (maxTurns/allowedTools/mcpServers instead of a fixed one-turn,
 * tool-less run) and the collector (turn/tool-call counters + trajectory, not just text).
 */
export async function runClaudeHeadlessAgent(
  prompt: string,
  opts: HeadlessAgentOpts,
  createQuery: CreateQueryFn,
  resolveCliPath: () => string | null = resolveClaudeCliPath
): Promise<HeadlessAgentResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const started = Date.now()
  let q: ReturnType<CreateQueryFn> | null = null
  let timer: NodeJS.Timeout | null = null
  try {
    const cliPath = opts.cliPath ?? resolveCliPath() ?? undefined
    q = createQuery({
      prompt: oneMessage(prompt),
      options: {
        // Same containment as runHeadless — see its comment on cwd.
        cwd: agentScratchCwd(),
        maxTurns: opts.maxIterations,
        allowedTools: opts.allowedTools,
        mcpServers: { argus: opts.mcpServer },
        env: claudeSpawnEnv(),
        ...(opts.model ? { model: opts.model } : {}),
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {})
      }
    })
    const result = await Promise.race([
      collectAgentRun(q, started),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`headless agent run timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      }),
      abortRacer(opts.signal)
    ])
    if (!result.text.trim()) throw new Error('headless agent run returned no text')
    return result
  } finally {
    if (timer) clearTimeout(timer)
    await q?.interrupt().catch(() => undefined)
  }
}
