import type { HeadlessOpts } from '../../driver'
import { codexHome } from './home'
import type { CodexClientFactory, CodexClientLike } from './client'
import { codexApprovalGen, mapCodexDecision } from './mapping'

/** clientInfo.version sent on `initialize` — kept a static constant (mirrors index.ts) so
 *  this module stays free of an electron import. Informational only on the wire. */
const CLIENT_VERSION = '0.0.0'

interface RawNotification {
  method: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any
}

/**
 * Resolve on `turn/completed` with the accumulated assistant text; reject on a
 * non-retryable `error` notification or a `turn/completed` whose `turn.status` is
 * `'failed'`/`'interrupted'`. Text is accumulated from `item/agentMessage/delta` (the
 * `delta` field) AND from `item/completed` agentMessage items (the `text` field) —
 * whichever arrives, since a headless one-shot has no reason to prefer one source once
 * both are seen (contract §5: `item/completed`'s `text` is the full/final text for that
 * item, so it simply overwrites/extends what deltas already built for the same item).
 */
function collectOneTurn(client: CodexClientLike): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let text = ''
    client.onNotification((raw: RawNotification) => {
      const p = raw?.params ?? {}
      switch (raw?.method) {
        case 'item/agentMessage/delta': {
          if (typeof p.delta === 'string') text += p.delta
          return
        }
        case 'item/completed': {
          const item = p.item ?? {}
          if (item.type === 'agentMessage' && typeof item.text === 'string') {
            text = item.text
          }
          return
        }
        case 'error': {
          // `willRetry: true` is a transient warning (contract §9) — only a falsy
          // willRetry is terminal.
          if (p.willRetry) return
          const message = p.error?.message
          reject(new Error(typeof message === 'string' ? message : 'Codex session error'))
          return
        }
        case 'turn/completed': {
          const turn = p.turn ?? {}
          if (turn.status === 'failed' || turn.status === 'interrupted') {
            reject(new Error(`headless run failed: ${String(turn.status)}`))
            return
          }
          if (!text.trim()) {
            reject(new Error('headless run returned no text'))
            return
          }
          resolve(text)
          return
        }
        default:
          return
      }
    })
  })
}

/**
 * Headless one-shot on the Codex `app-server` runtime: no case, no session row, no
 * mirror, no tools. Throws on failure. Mirrors `runClaudeHeadless`'s structure (accumulate
 * text, race against a timeout, throw on empty/failed, reap in `finally`) and
 * `runCopilotHeadless`'s app-server-style client lifecycle (boot a client against the
 * global `~/.codex` auth home, always tear it down).
 *
 * No tools/approvals: `thread/start` uses `approvalPolicy: 'never'` (the server decides
 * exec/patch outcomes itself rather than asking) with `sandbox: 'read-only'` (the
 * conservative floor — nothing destructive can happen even if the model tries). On top of
 * that, `onServerRequest` unconditionally declines every approval-request server request as a
 * backstop for any request kind the policy doesn't already suppress — a headless distillation
 * run has no human to consult and no case to act on, so it must never gate on or hang waiting
 * for an approval. The decline is generation-aware (mirrors `index.ts`'s `onServerRequest`):
 * `execCommandApproval`/`applyPatchApproval` (legacy) require `'denied'`, while the current
 * generation's `item/commandExecution|fileChange/requestApproval` methods require `'decline'` —
 * replying with the wrong generation's vocabulary would leave Codex unable to parse the
 * decision. Any other
 * server-initiated request (user-input, dynamic tool, auth refresh, ...) fails closed by
 * throwing, since a headless run has no channel to service it.
 */
export async function runCodexHeadless(
  prompt: string,
  opts: HeadlessOpts,
  clientFactory: CodexClientFactory,
  cliPath?: string
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  let client: CodexClientLike | null = null
  let timer: NodeJS.Timeout | null = null
  let timedOut = false
  try {
    // No per-instance override is threaded into HeadlessOpts, so CODEX_HOME is left unset
    // here — `codex` falls back to its own default (`~/.codex`), matching the session and
    // probe paths' no-override behavior (see home.ts).
    const home = codexHome()
    client = clientFactory({
      spawn: {
        command: opts.cliPath ?? cliPath ?? 'codex',
        args: ['app-server'],
        env: { ...process.env, ...(home ? { CODEX_HOME: home } : {}) }
      }
    })
    const c = client
    const run = (async () => {
      await c.start()
      await c.request('initialize', { clientInfo: { name: 'argus', version: CLIENT_VERSION } })
      c.notify('initialized')

      // Register inbound channels BEFORE opening the thread so no early notification is
      // missed (mirrors index.ts's createSession ordering).
      const collected = collectOneTurn(c)
      c.onServerRequest(async (req: { method: string }) => {
        const gen = codexApprovalGen(req.method)
        if (gen === null) {
          // Non-approval server request (user-input, dynamic tool, auth refresh, ...) —
          // a headless run has no channel to service it, so fail closed instead of hanging.
          throw new Error(`codex headless: unsupported server request ${req.method}`)
        }
        return mapCodexDecision({ behavior: 'deny', message: 'headless run: no approvals' }, gen)
      })

      const startParams = {
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ...(opts.model ? { model: opts.model } : {})
      }
      const result = (await c.request('thread/start', startParams)) as {
        thread?: { id?: unknown }
      }
      const threadId = result?.thread?.id
      if (typeof threadId !== 'string' || !threadId) {
        throw new Error('headless run: thread/start returned no thread id')
      }

      await c.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] })
      return collected
    })()
    run.catch(() => undefined) // never leak an unhandled rejection if it settles post-timeout
    const text = await Promise.race([
      run,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          timedOut = true
          rej(new Error(`headless run timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })
    ])
    if (!text.trim()) throw new Error('headless run returned no text')
    return text
  } finally {
    if (timer) clearTimeout(timer)
    if (timedOut) {
      await client?.forceStop().catch(() => undefined)
    } else {
      try {
        await client?.stop()
      } catch {
        await client?.forceStop().catch(() => undefined)
      }
    }
  }
}
