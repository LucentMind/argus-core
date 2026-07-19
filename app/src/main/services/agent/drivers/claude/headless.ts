import type { HeadlessOpts } from '../../driver'
import type { CreateQueryFn } from '.'
import { resolveClaudeCliPath } from './cliPath'

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

async function collectAssistantText(q: AsyncIterable<unknown>): Promise<string> {
  let last = ''
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
        throw new Error(`headless run failed: ${String(msg.subtype)}`)
      }
      break
    }
  }
  return last
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
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  let q: ReturnType<CreateQueryFn> | null = null
  let timer: NodeJS.Timeout | null = null
  try {
    const cliPath = opts.cliPath ?? resolveCliPath() ?? undefined
    q = createQuery({
      prompt: oneMessage(prompt),
      options: {
        maxTurns: 1,
        allowedTools: [],
        ...(opts.model ? { model: opts.model } : {}),
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {})
      }
    })
    const text = await Promise.race([
      collectAssistantText(q),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`headless run timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      })
    ])
    if (!text.trim()) throw new Error('headless run returned no text')
    return text
  } finally {
    if (timer) clearTimeout(timer)
    await q?.interrupt().catch(() => undefined)
  }
}
