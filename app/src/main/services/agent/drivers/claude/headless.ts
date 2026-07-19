import { query } from '@anthropic-ai/claude-agent-sdk'
import type { HeadlessOpts } from '../../driver'
import type { CreateQueryFn } from '.'

const defaultCreateQuery: CreateQueryFn = (args) =>
  query({ prompt: args.prompt as never, options: args.options as never }) as never

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

/** Headless one-shot: no case, no sessions row, no mirror, no tools. Throws on failure. */
export async function runClaudeHeadless(
  prompt: string,
  opts: HeadlessOpts,
  createQuery: CreateQueryFn = defaultCreateQuery
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  let q: ReturnType<CreateQueryFn> | null = null
  try {
    q = createQuery({
      prompt: oneMessage(prompt),
      options: {
        maxTurns: 1,
        allowedTools: [],
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.cliPath ? { pathToClaudeCodeExecutable: opts.cliPath } : {})
      }
    })
    const text = await Promise.race([
      collectAssistantText(q),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`headless run timed out after ${timeoutMs}ms`)), timeoutMs)
      )
    ])
    if (!text.trim()) throw new Error('headless run returned no text')
    return text
  } finally {
    await q?.interrupt().catch(() => undefined)
  }
}
