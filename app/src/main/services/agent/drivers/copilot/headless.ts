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

/** Resolve on turn end with the last finalized assistant message; reject on session.error. */
function collectOneTurn(session: CopilotSessionLike, prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let last = ''
    const off = session.on((raw: RawSdkEvent) => {
      const d = (raw?.data ?? {}) as Record<string, unknown>
      if (raw?.type === 'assistant.message' && d.content) {
        last = String(d.content)
      } else if (raw?.type === 'assistant.turn_end') {
        off()
        resolve(last)
      } else if (raw?.type === 'session.error') {
        off()
        reject(new Error(String(d.message ?? 'Copilot session error')))
      }
    })
    session.send({ prompt }).catch((e: unknown) => {
      off()
      reject(e instanceof Error ? e : new Error(String(e)))
    })
  })
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
  try {
    const resolved = opts.cliPath ?? cliPath
    client = clientFactory({
      baseDirectory: copilotHome(opts.argusHome),
      workingDirectory: scratch,
      ...(resolved ? { cliPath: resolved } : {})
    })
    await client.start()
    const session = await client.createSession({
      workingDirectory: scratch,
      systemMessage: { mode: 'append', content: '' },
      // No tools are registered, so nothing should ever ask. Deny rather than approve:
      // a headless distill run has no human to consult and no case to act on.
      onPermissionRequest: async () => ({
        kind: 'reject',
        feedback: 'headless run: tools are not available'
      }),
      tools: []
    })
    const text = await Promise.race([
      collectOneTurn(session, prompt),
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
    try {
      await client?.stop()
    } catch {
      await client?.forceStop().catch(() => undefined)
    }
    releaseTrap()
  }
}
