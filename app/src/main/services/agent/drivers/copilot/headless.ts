import fs from 'node:fs'
import path from 'node:path'
import type { HeadlessOpts } from '../../driver'
import { acquireAuthRejectionTrap } from './authTrap'
import {
  copilotHome,
  type CopilotClientFactory,
  type CopilotClientLike,
  type CopilotSessionLike
} from './client'
import type { RawSdkEvent } from './normalize'

/** Working directory for a case-less run. Not a case dir (there is no case) and not the
 *  repo/cwd (a headless run must not pollute it). Stable rather than a fresh temp dir so
 *  the runtime can reuse per-directory state across runs. */
export function headlessScratchDir(argusHome: string): string {
  return path.join(argusHome, '.headless')
}

/**
 * Resolve on turn end with the last finalized assistant message; reject on session.error.
 * The listener unsubscribe is exposed alongside the promise (not just called internally on
 * the three paths above) because a fourth exit exists that this function can't see or
 * control: the caller races this promise against a timeout, and when the timeout wins,
 * this promise is simply abandoned — nothing here ever runs to unsubscribe. `unsubscribe`
 * is idempotent so the caller can always call it in a `finally`, regardless of who won.
 */
function collectOneTurn(
  session: CopilotSessionLike,
  prompt: string
): { result: Promise<string>; unsubscribe: () => void } {
  let off: () => void = () => {}
  let unsubscribed = false
  const unsubscribe = (): void => {
    if (unsubscribed) return
    unsubscribed = true
    off()
  }
  const result = new Promise<string>((resolve, reject) => {
    let last = ''
    off = session.on((raw: RawSdkEvent) => {
      const d = (raw?.data ?? {}) as Record<string, unknown>
      if (raw?.type === 'assistant.message' && d.content) {
        last = String(d.content)
      } else if (raw?.type === 'assistant.turn_end') {
        unsubscribe()
        resolve(last)
      } else if (raw?.type === 'session.error') {
        unsubscribe()
        reject(new Error(String(d.message ?? 'Copilot session error')))
      }
    })
    session.send({ prompt }).catch((e: unknown) => {
      unsubscribe()
      reject(e instanceof Error ? e : new Error(String(e)))
    })
  })
  return { result, unsubscribe }
}

/**
 * Tool-less one-shot on the Copilot runtime. Follows the same case-less client lifecycle
 * probeAuth established: boot a client against a scratch dir, use it, always tear it down.
 */
export async function runCopilotHeadless(
  prompt: string,
  opts: HeadlessOpts,
  clientFactory: CopilotClientFactory,
  cliPath?: string
): Promise<string> {
  const scratch = headlessScratchDir(opts.argusHome)
  fs.mkdirSync(scratch, { recursive: true })
  const timeoutMs = opts.timeoutMs ?? 180_000
  const releaseTrap = acquireAuthRejectionTrap()
  let client: CopilotClientLike | null = null
  let timer: NodeJS.Timeout | null = null
  // The three settlement paths inside collectOneTurn already unsubscribe themselves; this
  // covers the timeout winning the race (assigned only once collectOneTurn runs, which may
  // never happen if start()/createSession() itself is what hangs) and is a no-op otherwise.
  let unsubscribe: () => void = () => {}
  try {
    const resolved = opts.cliPath ?? cliPath
    client = clientFactory({
      baseDirectory: copilotHome(opts.argusHome),
      workingDirectory: scratch,
      ...(resolved ? { cliPath: resolved } : {})
    })
    const c = client
    // start()/createSession()/send() must all be bounded by the same race as the turn
    // itself — a wedged transport handshake (start() never resolving) must not hang this
    // run forever, mirroring probeAuth's rationale at index.ts:505-506. Everything from
    // boot through the collected turn is folded into one awaited promise so the race
    // below covers the whole lifecycle, not just the final result.
    const run = (async () => {
      await c.start()
      const session = await c.createSession({
        workingDirectory: scratch,
        systemMessage: { mode: 'append', content: '' },
        // The runtime's OWN built-in tools (read/write/shell/url) are NOT governed by the
        // `tools` array below — that only scopes ARGUS-registered tools — so the runtime
        // can still raise a permission request here even with none registered. Deny with
        // the empirically-verified onPermissionRequest deny shape (EVIDENCE.md §2,
        // `rpc.d.ts:8157`, captured denying `url` in 04-read-fetch.jsonl — the SAME shape
        // `mapToolDecision` in index.ts uses for the chat driver's own permission
        // handler): a headless distill run has no human to consult and no case to act on.
        onPermissionRequest: async () => ({
          kind: 'reject',
          feedback: 'headless run: tools are not available'
        }),
        tools: []
      })
      const { result, unsubscribe: unsub } = collectOneTurn(session, prompt)
      unsubscribe = unsub
      return result
    })()
    run.catch(() => undefined) // never leak an unhandled rejection if it settles post-timeout
    const text = await Promise.race([
      run,
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
    unsubscribe()
    try {
      await client?.stop()
    } catch {
      await client?.forceStop().catch(() => undefined)
    }
    releaseTrap()
  }
}
