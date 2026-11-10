import type { AuthStatus } from '../../../../../shared/types'
import type { CreateQueryFn } from './index'
import { claudeSpawnEnv, resolveClaudeCliPath } from './cliPath'
import { agentScratchCwd } from '../../scratchCwd'

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

/**
 * The probe's prompt stream never yields. A user message — any user message — is a turn the
 * CLI runs against the model, and the model bills it.
 *
 * This used to yield a literal "ping" with `maxTurns: 0`, believing that triggered the CLI's
 * `system/init` without running a turn. It did not: the SDK forwards maxTurns as
 * `if (maxTurns) args.push('--max-turns', …)`, so 0 was dropped and the turn ran unlimited.
 * The model answered "pong" against the full system prompt and tool list, every five minutes
 * per enabled instance plus every settings write — 1,935 billed probes, ~30K cached input
 * tokens each, were found in the scratch-cwd transcripts of one machine (2026-11-10).
 *
 * Everything the probe needs arrives on the control channel instead: `initializationResult()`
 * resolves from the CLI's `initialize` handshake (~0.7s after spawn, measured live against SDK
 * 0.3.299 with the API base URL pointed at a capture server — only a `HEAD /api/hello`
 * connectivity check left the process). The `system/init` STREAM message, by contrast, is
 * only ever emitted once a user message arrives, so nothing here waits for it.
 */
export function silentPrompt(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<never>>(() => undefined)
    })
  }
}

type Account = { email?: string; subscriptionType?: string; tokenSource?: string }

/** The slice of the SDK's `SDKControlInitializeResponse` the probe reads. Verified live
 *  (0.3.299): `account` carries email/subscriptionType/tokenSource/apiProvider and
 *  `claude_code_version` is the same value `system/init` would carry. Both optional: older
 *  CLIs predate the version field, and a logged-out CLI reports an empty account. */
type InitResponse = { account?: Account; claude_code_version?: string }

type ProbeHandle = AsyncIterable<unknown> & {
  initializationResult?: () => Promise<InitResponse | undefined>
  interrupt?: () => Promise<unknown>
  close?: () => void
}

export async function probeAuth(
  createQuery: CreateQueryFn,
  opts: { timeoutMs?: number; cliPath?: string } = {}
): Promise<AuthStatus> {
  const timeoutMs = opts.timeoutMs ?? 10000
  // Same packaged-build escape as the session path (see resolveClaudeCliPath): without it the
  // probe reports a bogus "libc mismatch" instead of an auth verdict.
  const cliPath = opts.cliPath ?? resolveClaudeCliPath()
  let q: ProbeHandle | null = null
  try {
    q = createQuery({
      prompt: silentPrompt(),
      options: {
        // Without an explicit cwd the CLI inherits the app's — "/" for a Finder-launched
        // packaged build — and its boot-time discovery walks into TCC-protected folders,
        // prompting as Argus. An empty scratch dir rather than the temp root itself: the
        // same boot walk over a large %TEMP% outran this timeout every time (scratchCwd.ts).
        cwd: agentScratchCwd(),
        allowedTools: [],
        // Auth probe: keep it a pure handshake, with no auto-memory read. See claudeSpawnEnv.
        env: claudeSpawnEnv(),
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {})
      }
    }) as unknown as ProbeHandle
    const getInit = q.initializationResult
    if (typeof getInit !== 'function') {
      return {
        ok: false,
        verified: false,
        detail: 'claude SDK handle has no initializationResult()'
      }
    }
    // The stream is raced alongside the handshake not for its messages — there are none
    // without a user message — but for its failure modes: a spawn that fails rejects it, and
    // a CLI that dies at boot ends it. Either would otherwise surface only as the timeout.
    const outcome = await Promise.race([
      getInit.call(q).then((init): { init: InitResponse } => ({ init: init ?? {} })),
      (async (): Promise<'exited'> => {
        for await (const _ of q) void _
        return 'exited'
      })(),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs))
    ])
    if (outcome === 'timeout') {
      return {
        ok: false,
        verified: false,
        detail: 'probe timed out — is the claude CLI installed and logged in?'
      }
    }
    if (outcome === 'exited') {
      return { ok: false, verified: false, detail: 'claude CLI exited before initializing' }
    }
    const { init } = outcome
    const subscription = subscriptionLabel(
      init.account?.subscriptionType,
      init.account?.tokenSource
    )
    const version = init.claude_code_version
    return {
      ok: true,
      verified: false,
      detail: version ? `claude ready (Claude Code ${version})` : 'claude ready',
      ...(init.account?.email ? { email: init.account.email } : {}),
      ...(subscription ? { subscription } : {}),
      ...(version ? { version } : {})
    }
  } catch (err) {
    return { ok: false, verified: false, detail: (err as Error).message }
  } finally {
    // close() ends the subprocess outright. An interrupt() alone has nothing to interrupt
    // here — no turn ever ran — and a CLI left waiting on stdin would linger per probe.
    if (typeof q?.close === 'function') {
      try {
        q.close()
      } catch {
        // a handle that is already gone is the outcome wanted
      }
    } else {
      await q?.interrupt?.().catch(() => undefined)
    }
  }
}
