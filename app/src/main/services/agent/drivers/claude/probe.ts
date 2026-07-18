import type { AuthStatus } from '../../../../../shared/types'
import type { CreateQueryFn } from './index'

/** "max*"/"pro*"/"team*"/"enterprise*" prefixes win; apiKey token source overrides all; else title-case. */
function subscriptionLabel(
  subscriptionType: string | undefined,
  tokenSource: string | undefined
): string | undefined {
  if (tokenSource === 'apiKey') return 'API key'
  if (!subscriptionType) return undefined
  const normalized = subscriptionType.toLowerCase()
  if (normalized.startsWith('max')) return 'Claude Max Subscription'
  if (normalized.startsWith('pro')) return 'Claude Pro Subscription'
  if (normalized.startsWith('team')) return 'Claude Team Subscription'
  if (normalized.startsWith('enterprise')) return 'Claude Enterprise'
  return subscriptionType
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

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

type Account = { email?: string; subscriptionType?: string; tokenSource?: string }

// Ground truth (verified live against @anthropic-ai/claude-agent-sdk@0.3.205,
// authenticated CLI): the system/init stream message carries NO `account`
// field at all — only `claude_code_version` (not `version`). Account info
// (email/subscriptionType/tokenSource/...) lives exclusively on the response
// of the query handle's `initializationResult()` control-channel call. We
// still fall back to reading `account`/`version` off the init message itself
// for forward/backward compat with SDK builds that might carry it there.
type InitHandle = { initializationResult?: () => Promise<{ account?: Account } | undefined> }

export async function probeAuth(
  createQuery: CreateQueryFn,
  opts: { timeoutMs?: number; cliPath?: string } = {}
): Promise<AuthStatus> {
  const timeoutMs = opts.timeoutMs ?? 10000
  const deadline = Date.now() + timeoutMs
  let q: ReturnType<CreateQueryFn> | null = null
  try {
    q = createQuery({
      prompt: onePing(),
      options: {
        maxTurns: 0,
        allowedTools: [],
        ...(opts.cliPath ? { pathToClaudeCodeExecutable: opts.cliPath } : {})
      }
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
      return {
        ok: false,
        verified: false,
        detail: 'probe timed out — is the claude CLI installed and logged in?'
      }
    }
    if (first && typeof first === 'object') {
      const m = first as {
        model?: string
        claude_code_version?: string
        version?: string
        account?: Account
      }

      let account = m.account
      const getInitResult = (q as unknown as InitHandle).initializationResult
      if (typeof getInitResult === 'function') {
        const remaining = Math.max(0, deadline - Date.now())
        const initResult = await Promise.race([
          getInitResult.call(q).catch(() => undefined),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), remaining))
        ])
        if (initResult?.account) account = initResult.account
      }

      const subscription = subscriptionLabel(account?.subscriptionType, account?.tokenSource)
      const version = m.claude_code_version ?? m.version
      return {
        ok: true,
        verified: false,
        detail: `claude ready (${m.model ?? 'unknown model'})`,
        ...(account?.email ? { email: account.email } : {}),
        ...(subscription ? { subscription } : {}),
        ...(version ? { version } : {})
      }
    }
    return { ok: false, verified: false, detail: 'claude CLI exited before initializing' }
  } catch (err) {
    return { ok: false, verified: false, detail: (err as Error).message }
  } finally {
    await q?.interrupt().catch(() => undefined)
  }
}
