import { AsyncQueue } from '../../asyncQueue'
import { PERMISSION_MODES } from '../../../../../shared/settings'
import type { AgentEvent } from '../../../../../shared/agent-events'
import type {
  AgentDriver,
  DriverSession,
  DriverSessionContext,
  ProbeAuthResult
} from '../../driver'
import { CODEX_TOOL_TAXONOMY } from './taxonomy'
import { createCodexNormalizer, type RawCodexNotification } from './normalize'
import { codexApprovalGen, synthesizeCodexApproval, mapCodexDecision } from './mapping'
import { codexHome } from './home'
import { defaultCodexClientFactory, type CodexClientFactory, type CodexClientLike } from './client'
import { runCodexHeadless } from './headless'

/** clientInfo.version sent on `initialize`. Kept a static constant rather than reading
 *  `electron.app.getVersion()` so this module stays free of an electron import (main-process
 *  tests use DI and never mock electron). The value is informational only on the wire. */
const CLIENT_VERSION = '0.0.0'

/** A fatal stream/transport error is threaded through the events queue as this sentinel so
 *  it can propagate out of `events()` (mirrors copilot's `FatalItem`) without an
 *  out-of-band throw. */
interface FatalItem {
  __fatal: unknown
}
type QueueItem = RawCodexNotification | FatalItem
function isFatal(item: QueueItem): item is FatalItem {
  return typeof item === 'object' && item !== null && '__fatal' in item
}

/** Recoverable = the resumed thread is gone. There is no typed error code on the wire
 *  (contract §8) — match t3code's shipped substring heuristic: message contains `'thread'`
 *  AND one of the "gone" phrases. Anything else re-throws (a real failure, not a stale id). */
const RESUME_GONE_PHRASES = [
  'not found',
  'missing thread',
  'no such thread',
  'unknown thread',
  'does not exist'
]
export function isRecoverableResumeError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return msg.includes('thread') && RESUME_GONE_PHRASES.some((p) => msg.includes(p))
}

function isFileChangeMethod(method: string): boolean {
  return method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval'
}

/**
 * Current-gen file approvals (`item/fileChange/requestApproval`) carry only `itemId` — the
 * diff arrived earlier on `item/fileChange/patchUpdated` / `item/started`(fileChange). Enrich
 * the approval params with the correlated `changes` so `synthesizeCodexApproval` can classify
 * `file_path`. If no correlated changes are found, proceed with the raw params (classification
 * still fails safe on an undefined path). Legacy `applyPatchApproval` already carries its
 * `fileChanges` map inline, so it is left untouched.
 */
function enrichApprovalParams(
  method: string,
  params: Record<string, unknown>,
  itemChanges: ReadonlyMap<string, unknown[]>
): Record<string, unknown> {
  if (method !== 'item/fileChange/requestApproval') return params
  const itemId = typeof params.itemId === 'string' ? params.itemId : ''
  const changes = itemId ? itemChanges.get(itemId) : undefined
  return changes ? { ...params, changes } : params
}

/** Populate the itemId→changes side table from the notifications that carry diffs, so a later
 *  file approval (which arrives as a server request, out of the events() queue) can correlate.
 *  Runs synchronously in wire order inside `onNotification`, BEFORE the approval line is
 *  parsed — never consult it from the queue-draining loop, which is consumer-paced and would
 *  race the approval. */
function recordItemChanges(msg: RawCodexNotification, itemChanges: Map<string, unknown[]>): void {
  if (msg.method === 'item/fileChange/patchUpdated') {
    const p = (msg.params ?? {}) as { itemId?: unknown; changes?: unknown }
    const itemId = typeof p.itemId === 'string' ? p.itemId : ''
    if (itemId && Array.isArray(p.changes)) {
      itemChanges.set(itemId, [...(itemChanges.get(itemId) ?? []), ...p.changes])
    }
  } else if (msg.method === 'item/started') {
    const item = (
      (msg.params ?? {}) as { item?: { type?: unknown; id?: unknown; changes?: unknown } }
    ).item
    if (item && item.type === 'fileChange' && Array.isArray(item.changes)) {
      const itemId = typeof item.id === 'string' ? item.id : ''
      if (itemId) itemChanges.set(itemId, item.changes)
    }
  }
}

export interface CodexDriverDeps {
  /** Injected at the client.ts seam; tests pass a scripted fake to avoid the real runtime. */
  clientFactory?: CodexClientFactory
}

export function createCodexDriver(
  config: { cliPath?: string; model?: string } = {},
  deps: CodexDriverDeps = {}
): AgentDriver {
  const clientFactory = deps.clientFactory ?? defaultCodexClientFactory
  // Per-instance CODEX_HOME override is not a named field on the shared config type (Task 3),
  // so read it via a safe cast (matches the brief).
  const codexHomeOverride = (config as { codexHome?: string }).codexHome

  return {
    kind: 'codex',
    toolTaxonomy: CODEX_TOOL_TAXONOMY,
    authFixHint:
      'Sign in to Codex with `codex login` (an OpenAI/ChatGPT account with Codex access), or set OPENAI_API_KEY.',
    npmPackage: '@openai/codex',
    updateCommand: 'npm install -g @openai/codex@latest',
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: false, // the approval decision reply carries no edited input
      costReporting: false, // no cost field anywhere on this wire (contract §7) — token counts only
      headlessOneShot: true // runHeadless is present, below
    },

    runHeadless: (prompt, opts) => runCodexHeadless(prompt, opts, clientFactory, config.cliPath),

    createSession(ctx: DriverSessionContext): DriverSession {
      const queue = new AsyncQueue<QueueItem>()
      const norm = createCodexNormalizer({
        resumed: Boolean(ctx.resumeCursor),
        model: ctx.model ?? 'gpt-5.4'
      })

      let client: CodexClientLike | null = null
      let threadId: string | null = null
      let activeTurnId: string | null = null
      const pendingPrompts: string[] = []
      let ended = false
      let stopped = false

      // Correlates current-gen file approvals (itemId only) to their diff (arrives earlier
      // on patchUpdated / item-started). Populated synchronously in onNotification.
      const itemChanges = new Map<string, unknown[]>()

      // Aborts pending approval promises when the session ends/interrupts; also the signal
      // whose `aborted` state routes an incoming approval to cancel/abort.
      const abort = new AbortController()

      const stopClient = (): void => {
        if (stopped) return
        stopped = true
        // client may still be initializing — chain on `ready` so stop can never race init.
        void ready.finally(async () => {
          try {
            await client?.stop()
          } catch {
            await client?.forceStop().catch(() => undefined)
          }
        })
      }

      const doSend = (text: string): void => {
        const tid = threadId
        if (!tid || !client) return
        // `turn/start` resolves quickly with the turnId; the response then streams as
        // notifications until `turn/completed`. A rejection means the turn never started —
        // surface it as fatal so events() ends instead of hanging on a stream that never comes.
        client
          .request('turn/start', { threadId: tid, input: [{ type: 'text', text }] })
          .then((res) => {
            const id = (res as { turn?: { id?: unknown } })?.turn?.id
            if (typeof id === 'string') activeTurnId = id
          })
          .catch((err) => queue.push({ __fatal: err }))
      }

      /**
       * Server-initiated approval bridge. `req = { id, method, params }`.
       * - Non-approval server requests (user-input, dynamic tool call, auth refresh,
       *   attestation, elicitation) → fail closed with a JSON-RPC error (the client writes
       *   `{id, error}`); Argus never silently accepts an unknown server request.
       * - Aborted session → cancel (current) / abort (legacy): deny AND interrupt.
       * - bypassPermissions → auto-accept without a card.
       * - acceptEdits + a file-change approval → auto-accept UNLESS classifyOnly says deny.
       * - Otherwise route through `ctx.onToolRequest` and map the verdict back to the
       *   generation's decision vocabulary.
       */
      const onServerRequest = async (req: {
        id: number
        method: string
        params?: unknown
      }): Promise<unknown> => {
        const gen = codexApprovalGen(req.method)
        if (gen === null) {
          throw new Error(`Unsupported Codex server request declined: ${req.method}`)
        }
        if (abort.signal.aborted) {
          return { decision: gen === 'current' ? 'cancel' : 'abort' }
        }
        const rawParams = (req.params as Record<string, unknown>) ?? {}
        if (ctx.permissionMode === 'bypassPermissions') {
          return { decision: gen === 'current' ? 'accept' : 'approved' }
        }
        const params = enrichApprovalParams(req.method, rawParams, itemChanges)
        const { name, input } = synthesizeCodexApproval(req.method, params)
        if (ctx.permissionMode === 'acceptEdits' && isFileChangeMethod(req.method)) {
          const verdict = ctx.classifyOnly?.(name, input)
          if (verdict?.action === 'deny') {
            return mapCodexDecision(
              { behavior: 'deny', message: verdict.reason ?? 'Denied by sandbox policy' },
              gen
            )
          }
          return { decision: gen === 'current' ? 'accept' : 'approved' }
        }
        const decision = await ctx.onToolRequest(name, input, { signal: abort.signal })
        return mapCodexDecision(decision, gen)
      }

      // Async session bootstrap. Any init failure (bad runtime, resume rejection that isn't
      // recoverable) propagates out of events() as a fatal item.
      const ready: Promise<void> = (async () => {
        // No override ⇒ leave CODEX_HOME unset so `codex` falls back to its own default
        // (`~/.codex`, where a plain `codex login` writes auth.json) — see home.ts. Only an
        // opt-in per-instance override pins CODEX_HOME to a separate dir.
        const home = codexHome(codexHomeOverride)
        client = clientFactory({
          spawn: {
            command: config.cliPath ?? 'codex',
            args: ['app-server'],
            env: {
              ...process.env,
              ...(home ? { CODEX_HOME: home } : {})
            }
          }
        })
        await client.start()
        await client.request('initialize', {
          clientInfo: { name: 'argus', version: CLIENT_VERSION }
        })
        client.notify('initialized')

        // Register inbound channels BEFORE opening the thread so no early notification /
        // approval is missed. recordItemChanges runs in wire order, ahead of any approval.
        client.onNotification((msg) => {
          recordItemChanges(msg, itemChanges)
          queue.push(msg)
        })
        client.onServerRequest(onServerRequest)
        client.onExit?.((info) => {
          if (stopped || ended) {
            queue.end()
            return
          }
          const code = info?.code
          queue.push({
            __fatal: new Error(
              `Codex app-server exited${typeof code === 'number' ? ` (code ${code})` : ''}`
            )
          })
        })

        // Argus owns approval gating (every exec/patch re-enters onToolRequest), so request
        // server-side approvals for everything: `approvalPolicy: 'untrusted'` makes the server
        // ask before every exec/patch. `sandbox: 'read-only'` is the conservative floor —
        // approved actions still execute through the approval flow; only unapproved autonomous
        // writes are blocked. This mirrors t3code's shipped CodexSessionRuntime start params.
        const startParams: Record<string, unknown> = {
          cwd: ctx.caseDir,
          approvalPolicy: 'untrusted',
          sandbox: 'read-only',
          ...(ctx.model ? { model: ctx.model } : {}),
          // Persona + memory-index text (driver.ts DriverSessionContext.systemAppend), forwarded
          // as the wire's developerInstructions (contract §?) — mirrors copilot's
          // systemMessage:{mode:'append'} forwarding. Omit the key entirely when empty/undefined
          // rather than sending an empty string.
          ...(ctx.systemAppend ? { developerInstructions: ctx.systemAppend } : {})
        }

        let result: unknown
        if (ctx.resumeCursor) {
          try {
            result = await client.request('thread/resume', {
              threadId: ctx.resumeCursor,
              ...startParams
            })
          } catch (err) {
            if (!isRecoverableResumeError(err)) throw err
            // The stored thread is gone — start fresh with the same params (contract §8).
            console.warn(
              `[codex] thread/resume failed (${err instanceof Error ? err.message : String(err)}); starting a fresh thread`
            )
            result = await client.request('thread/start', startParams)
          }
        } else {
          result = await client.request('thread/start', startParams)
        }

        const tid = (result as { thread?: { id?: unknown } })?.thread?.id
        if (typeof tid === 'string' && tid) {
          threadId = tid
          ctx.onCursor(tid) // durable resume cursor, known as soon as the thread exists
        }

        // Flush any prompts that arrived before the thread was ready.
        for (const p of pendingPrompts) doSend(p)
        pendingPrompts.length = 0
      })().catch((err) => {
        queue.push({ __fatal: err })
      })

      async function* events(): AsyncIterable<AgentEvent> {
        try {
          for await (const item of queue) {
            if (isFatal(item)) throw item.__fatal
            const raw = item

            // A non-retryable `error` notification is terminal — throw so the harness emits
            // session.error + session.exited('crashed'), mirroring copilot's session.error
            // path. `willRetry:true` is a transient warning the normalizer already drops.
            if (
              raw.method === 'error' &&
              !(raw.params as { willRetry?: unknown } | undefined)?.willRetry
            ) {
              const message = (raw.params as { error?: { message?: unknown } } | undefined)?.error
                ?.message
              throw new Error(typeof message === 'string' ? message : 'Codex session error')
            }

            // Contract invariant 7: onTurnResult MUST fire before turn.completed is yielded.
            // `turn/completed` is the SOLE turn boundary; the boundary can be success,
            // interrupted, OR error — all three fire onTurnResult (truthy).
            const boundary = norm.turnBoundary(raw)
            if (boundary) ctx.onTurnResult(norm.turnResult())

            for (const ev of norm.normalize(raw, ctx.eventCtx())) yield ev
          }
        } finally {
          // Any stream termination — normal end, a thrown fatal, or the consumer breaking out
          // — reaps the runtime. The harness's consume-catch marks the session dead WITHOUT
          // calling end() on the crash path, so end() alone would leak the child.
          stopClient()
        }
      }

      return {
        events,
        send(text: string): void {
          if (ended) return
          if (threadId) doSend(text)
          else pendingPrompts.push(text)
        },
        async interrupt(): Promise<void> {
          await ready.catch(() => undefined)
          abort.abort()
          if (threadId && activeTurnId) {
            await client
              ?.request('turn/interrupt', { threadId, turnId: activeTurnId })
              .catch(() => undefined)
          }
        },
        end(): void {
          if (ended) return
          ended = true
          abort.abort() // reject any approval card still pending at teardown
          queue.end()
          stopClient() // never leave an orphaned runtime
        }
      }
    },

    /**
     * Turn-free probe: boot the app-server, handshake, then `account/read` (contract §10 —
     * what the reference client exercises end-to-end). Bounded by `timeoutMs` so a wedged
     * `start()` can never hang the periodic probe, and the client is always reaped.
     */
    async probeAuth(config2: { cliPath?: string; timeoutMs?: number }): Promise<ProbeAuthResult> {
      const timeoutMs = config2.timeoutMs ?? 10000
      let client: CodexClientLike | null = null
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      try {
        // Codex auth (`auth.json`) is CODEX_HOME-scoped, so the probe must resolve CODEX_HOME
        // identically to a real session/headless run — via the same `codexHome()` helper — or
        // the three could disagree on auth state. No override ⇒ leave CODEX_HOME unset so
        // `codex` falls back to ITS OWN default (`~/.codex`, where a plain `codex login`
        // writes) — never a scratch dir, which would always read as signed-out regardless of
        // real auth state. An override ⇒ CODEX_HOME pinned to that dir, matching the session
        // path for the same instance.
        const home = codexHome(codexHomeOverride)
        client = clientFactory({
          spawn: {
            command: config2.cliPath ?? config.cliPath ?? 'codex',
            args: ['app-server'],
            env: { ...process.env, ...(home ? { CODEX_HOME: home } : {}) }
          }
        })
        const c = client
        const probe = (async () => {
          await c.start()
          const init = (await c.request('initialize', {
            clientInfo: { name: 'argus', version: CLIENT_VERSION }
          })) as { userAgent?: string }
          c.notify('initialized')
          const account = (await c.request('account/read', {})) as {
            account?: { type?: string; email?: string; planType?: string } | null
            requiresOpenaiAuth?: boolean
          }
          return { version: init?.userAgent, account }
        })()
        probe.catch(() => undefined) // never leak if it settles post-timeout
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            reject(new Error('codex-probe-timeout'))
          }, timeoutMs)
          timer.unref?.()
        })
        const { version, account } = await Promise.race([probe, timeout])
        if (account?.requiresOpenaiAuth || !account?.account) {
          return {
            ok: false,
            detail: 'Codex not authenticated — run `codex login`',
            ...(version ? { version } : {})
          }
        }
        const acct = account.account
        const email = acct.type === 'chatgpt' ? acct.email : undefined
        const sub = acct.planType
        const who = email ? ` (${email}${sub ? `, ${sub}` : ''})` : sub ? ` (${sub})` : ''
        return {
          ok: true,
          detail: `codex ready${who}`,
          ...(email ? { email } : {}),
          ...(sub ? { subscription: sub } : {}),
          ...(version ? { version } : {})
        }
      } catch (err) {
        if (timedOut) return { ok: false, detail: `Codex probe timed out after ${timeoutMs}ms` }
        const e = err as NodeJS.ErrnoException
        const spawnShaped = e?.code === 'ENOENT' || /ENOENT|spawn/i.test(e?.message ?? '')
        return {
          ok: false,
          detail: spawnShaped
            ? 'Codex runtime not found — check the CLI path or install the codex binary'
            : (e?.message ?? String(err))
        }
      } finally {
        if (timer) clearTimeout(timer)
        await client?.stop().catch(() => client?.forceStop().catch(() => undefined))
      }
    }
  }
}
