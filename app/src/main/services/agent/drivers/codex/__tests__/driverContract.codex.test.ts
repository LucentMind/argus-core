import { vi, it, expect } from 'vitest'
import { createCodexDriver } from '../index'
import type { CodexClientFactory, CodexClientLike } from '../client'
import { runDriverContractSuite, type TransportScript } from '../../../__tests__/driverContract'
import { DRIVERS } from '../../../../../../shared/drivers'

const DEFAULT_THREAD_ID = '33333333-3333-4333-8333-333333333333'

type Notification = { method: string; params?: unknown }
type ServerRequest = { id: number; method: string; params?: unknown }
type ServerRequestCb = (req: ServerRequest) => Promise<unknown>
type ExitInfo = { code: number | null; signal: string | null }

let currentScript: TransportScript = {}

// The codex script is enacted as raw `app-server` wire traffic. The fake client produces
// nothing until the driver sends a prompt (→ `turn/start`), then drives one turn per the
// current script via the captured notification channel — exactly the ordering invariant 2
// pins. Approvals are routed back through the onServerRequest handler the driver installs
// (invariant 3).
//
// Codex's persistent connection has no in-band "session over" notification, so — after a
// completed turn — the fake fires the captured onExit callback with a CLEAN exit
// ({ code: 0, signal: null }). That graceful close is the codex analog of copilot's
// post-turn `session.shutdown`: it terminates events() so the contract's single-turn
// invariants (which drain events() without calling end()) don't hang. The throwMidStream
// path deliberately does NOT fire a clean exit — it must terminate by throwing.
function fakeFactory(): CodexClientFactory {
  return () => {
    let notificationCb: ((msg: Notification) => void) | undefined
    let serverRequestCb: ServerRequestCb | undefined
    let exitCb: ((info?: ExitInfo) => void) | undefined
    const threadId = currentScript.checkpoint ?? DEFAULT_THREAD_ID

    const notify = (method: string, params: unknown): void => notificationCb?.({ method, params })

    async function drive(script: TransportScript): Promise<void> {
      // A non-retryable `error` notification is a terminal stream failure the driver
      // propagates out of events() (invariant 5). No clean exit on this path.
      if (script.throwMidStream) {
        notify('error', { error: { message: 'scripted transport failure' }, willRetry: false })
        return
      }

      const turnId = 'turn-1'
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })

      for (const text of script.content ?? []) {
        notify('item/agentMessage/delta', { delta: text, itemId: 'm1', threadId, turnId })
      }

      if (script.toolCall) {
        const command =
          typeof (script.toolCall.input as { command?: unknown }).command === 'string'
            ? (script.toolCall.input as { command: string }).command
            : script.toolCall.name
        notify('item/started', {
          threadId,
          turnId,
          item: { type: 'commandExecution', id: 'c1', command }
        })
        // Server-initiated approval request → the driver's onServerRequest bridge → onToolRequest.
        const decision = (await serverRequestCb?.({
          id: 1,
          method: 'item/commandExecution/requestApproval',
          params: { itemId: 'c1', command, threadId, turnId }
        })) as { decision?: string } | undefined
        // Only an accept executes the command; a deny/decline emits nothing further and the
        // stream continues to completion (invariant 3).
        if (decision?.decision === 'accept') {
          notify('item/completed', {
            threadId,
            turnId,
            item: {
              type: 'commandExecution',
              id: 'c1',
              exitCode: 0,
              aggregatedOutput: 'ran',
              status: 'completed'
            }
          })
        }
      }

      if (script.completeTurn) {
        notify('thread/tokenUsage/updated', {
          threadId,
          tokenUsage: { last: { inputTokens: 5, outputTokens: 2 } }
        })
        notify('turn/completed', {
          threadId,
          turn: { id: turnId, status: 'completed', durationMs: 10 }
        })
        // Codex analog of copilot's post-turn session.shutdown: a clean server-side close so
        // events() terminates normally after this single scripted turn.
        exitCb?.({ code: 0, signal: null })
      }
    }

    const client: CodexClientLike = {
      async start() {
        /* no-op transport */
      },
      async request(method) {
        if (method === 'initialize') return {}
        if (method === 'thread/start' || method === 'thread/resume') {
          return { thread: { id: threadId } }
        }
        if (method === 'turn/start') {
          // Resolve with the turn id first (the driver records activeTurnId), then drive the
          // scripted turn as notifications — mirrors the real request→stream ordering.
          queueMicrotask(() => void drive(currentScript))
          return { turn: { id: 'turn-1' } }
        }
        if (method === 'turn/interrupt') return {}
        return {}
      },
      notify() {
        /* no-op */
      },
      onNotification(cb) {
        notificationCb = cb
      },
      onServerRequest(cb) {
        serverRequestCb = cb
      },
      onExit(cb) {
        exitCb = cb
      },
      stop: vi.fn(async () => undefined),
      forceStop: vi.fn(async () => undefined)
    }
    return client
  }
}

runDriverContractSuite(
  () => createCodexDriver({}, { clientFactory: fakeFactory() }),
  (script) => {
    currentScript = script
  }
)

it('declared headlessOneShot matches runHeadless presence', () => {
  const d = createCodexDriver()
  expect(d.capabilities.headlessOneShot).toBe(typeof d.runHeadless === 'function')
})

// resolveDistillProvider (shared/drivers.ts) gates on the SHARED flag; what actually runs
// is the main-side method. If shared says true but the method is absent (or vice versa),
// distillation either silently refuses a working provider or throws on a provider the UI
// claims supports it. All three — shared flag, main-side flag, main-side method — must agree.
it('shared DRIVERS headlessOneShot agrees with the main-process driver flag and method', () => {
  const d = createCodexDriver()
  expect(DRIVERS[d.kind].capabilities.headlessOneShot).toBe(d.capabilities.headlessOneShot)
  expect(DRIVERS[d.kind].capabilities.headlessOneShot).toBe(typeof d.runHeadless === 'function')
})
