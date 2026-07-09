import type { AuthStatus } from '../../../shared/types'
import type { CreateQueryFn } from './session'

// The CLI only emits system/init after the prompt stream yields a first message,
// so a never-yielding probe would always time out. One ping with maxTurns: 0
// triggers init without running (or billing) a turn.
async function* onePing(): AsyncGenerator<unknown> {
  yield {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'ping' }] },
    parent_tool_use_id: null,
    session_id: ''
  }
  await new Promise(() => undefined)
}

export async function probeAuth(
  createQuery: CreateQueryFn,
  opts: { timeoutMs?: number } = {}
): Promise<AuthStatus> {
  const timeoutMs = opts.timeoutMs ?? 10000
  let q: ReturnType<CreateQueryFn> | null = null
  try {
    q = createQuery({
      prompt: onePing(),
      options: { maxTurns: 0, allowedTools: [] }
    })
    const first = await Promise.race([
      (async (): Promise<unknown> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const msg of q as AsyncIterable<any>) {
          if (msg?.type === 'system' && msg.subtype === 'init') return msg
        }
        return null
      })(),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs))
    ])
    if (first === 'timeout') {
      return { ok: false, detail: 'probe timed out — is the claude CLI installed and logged in?' }
    }
    if (first && typeof first === 'object') {
      const m = first as { model?: string }
      return { ok: true, detail: `claude ready (${m.model ?? 'unknown model'})` }
    }
    return { ok: false, detail: 'claude CLI exited before initializing' }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  } finally {
    await q?.interrupt().catch(() => undefined)
  }
}
