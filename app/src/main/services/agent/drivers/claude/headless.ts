import {
  abortRacer,
  type HeadlessOpts,
  type HeadlessResult,
  type HeadlessUsage
} from '../../driver'
import type { CreateQueryFn } from '.'
import { claudeSpawnEnv, resolveClaudeCliPath } from './cliPath'
import { agentScratchCwd } from '../../scratchCwd'

// One message, then hold the stream open — the CLI only emits after the prompt
// stream yields (probe.ts idiom); interrupt() in finally tears the process down.
async function* oneMessage(text: string): AsyncGenerator<unknown> {
  yield {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: ''
  }
  await new Promise(() => undefined)
}

/** The SDK's own diagnostics on a non-success `result` (`SDKResultError`'s `num_turns`,
 *  `stop_reason`, `terminal_reason`, `errors`) — folded into the thrown message since a plain
 *  `StageRecord.error` string is the only channel that survives to the persisted job and the
 *  run panel. Only fields the message actually reported are included, so a cap hit that
 *  recurs even with headroom carries enough to diagnose without a fabricated "undefined". */
function resultErrorDetail(msg: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof msg.num_turns === 'number') parts.push(`num_turns=${msg.num_turns}`)
  if (typeof msg.stop_reason === 'string') parts.push(`stop_reason=${msg.stop_reason}`)
  if (typeof msg.terminal_reason === 'string') parts.push(`terminal_reason=${msg.terminal_reason}`)
  if (Array.isArray(msg.errors) && msg.errors.length > 0)
    parts.push(`errors=${JSON.stringify(msg.errors)}`)
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

/** Accumulates assistant text and, on the terminal `result` message, the run's token/cost
 *  usage. Fields the SDK didn't report on `result` stay absent — never a fabricated `0`. */
async function collectAssistant(
  q: AsyncIterable<unknown>,
  started: number
): Promise<{ text: string; usage?: HeadlessUsage }> {
  let last = ''
  let usage: HeadlessUsage | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const msg of q as AsyncIterable<any>) {
    if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
      const t = msg.message.content
        .filter((b: { type?: string }) => b?.type === 'text')
        .map((b: { text?: unknown }) => String(b.text ?? ''))
        .join('')
      if (t.trim()) last = t
    }
    if (msg?.type === 'result') {
      if (msg.subtype && msg.subtype !== 'success') {
        throw new Error(`headless run failed: ${String(msg.subtype)}${resultErrorDetail(msg)}`)
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
  return { text: last, usage }
}

/**
 * Headless one-shot: no case, no sessions row, no mirror, no tools. Throws on failure.
 *
 * `resolveCliPath` mirrors the fallback `createSession` uses (index.ts:78): a user-configured
 * `opts.cliPath` wins, but absent that, a packaged build must still escape the un-spawnable
 * in-asar binary (see cliPath.ts) rather than let the SDK resolve it and fail with a
 * misleading libc error. Injectable (default: the real resolver) so tests can pin the
 * fallback without depending on whether the test run happens to be inside an asar.
 */
export async function runClaudeHeadless(
  prompt: string,
  opts: HeadlessOpts,
  createQuery: CreateQueryFn,
  resolveCliPath: () => string | null = resolveClaudeCliPath
): Promise<HeadlessResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const started = Date.now()
  let q: ReturnType<CreateQueryFn> | null = null
  let timer: NodeJS.Timeout | null = null
  try {
    const cliPath = opts.cliPath ?? resolveCliPath() ?? undefined
    q = createQuery({
      prompt: oneMessage(prompt),
      options: {
        // Without an explicit cwd the CLI inherits the app's — "/" for a Finder-launched
        // packaged build — and its boot-time discovery walks into TCC-protected folders,
        // prompting as Argus. Same containment as the auth probe (probe.ts), and the same
        // empty scratch dir rather than the temp root (scratchCwd.ts).
        cwd: agentScratchCwd(),
        maxTurns: 1,
        // Two layers, one intent. `tools: []` disables the BUILT-IN tool set (Read/Bash/...) so the
        // model is never OFFERED one; `allowedTools: []` is the permission gate. The gate alone is
        // not enough: live-verified (SDK 0.3.220), a prompt that tempts a Read gets a tool_use on
        // turn 1, the denial spends that turn, and the run dies as error_max_turns (num_turns=2,
        // stop_reason=tool_use) at maxTurns:1 — with `tools: []` the same prompt completes in one
        // turn. maxTurns stays 1 on purpose: a one-shot that needs two turns is a bug to surface
        // (see resultErrorDetail), not headroom to absorb.
        tools: [],
        allowedTools: [],
        // No auto-memory in a one-shot: it cannot write here (no tools), but it would still
        // read unrelated memories into the prompt. See claudeSpawnEnv.
        env: claudeSpawnEnv(),
        ...(opts.model ? { model: opts.model } : {}),
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {})
      }
    })
    const result = await Promise.race([
      collectAssistant(q, started),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`headless run timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      }),
      abortRacer(opts.signal)
    ])
    if (!result.text.trim()) throw new Error('headless run returned no text')
    return result
  } finally {
    if (timer) clearTimeout(timer)
    await q?.interrupt().catch(() => undefined)
  }
}
