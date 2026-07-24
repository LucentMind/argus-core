import { vi, it, expect } from 'vitest'
import { createAcpDriver } from '../index'
import type {
  AcpClientFactory,
  AcpClientFactoryOpts,
  AcpClientLike,
  AcpSessionLike,
  AcpSessionUpdate
} from '../client'
import { runDriverContractSuite, type TransportScript } from '../../../__tests__/driverContract'
import { DRIVERS } from '../../../../../../shared/drivers'
import { GROK_PROFILE } from '../profiles/grok'

const DEFAULT_SESSION_ID = '55555555-5555-4555-8555-555555555555'

let currentScript: TransportScript = {}

// ACP script entries are enacted as flat `session/update` sub-objects delivered through the
// PER-SESSION `onUpdate` callback the driver subscribes via `AcpSessionLike.onUpdate` — the
// authoritative sink (client.ts's `routeSessionUpdate` precedence; the factory-level `onUpdate`
// is only a fallback the driver never uses). `prompt()` drives that callback directly, then
// settles per the script: throws for `throwMidStream` (the driver's `doPrompt().catch` pushes a
// fatal `{type:'error'}` item — invariant 5), else resolves so the driver threads its own
// synthetic `turn.completed` boundary item (index.ts has no `session/update` variant that
// signals turn end — see normalize.ts's `turnBoundary`). Tool calls route through the injected
// `onPermission` exactly like the real `requestPermission` wire call; only the `allow_once`
// verdict is followed by a `tool_call`/`tool_call_update` pair — a deny emits nothing further
// but the stream still completes (invariant 3).
function makeFakeSession(
  sessionId: string,
  getScript: () => TransportScript,
  onPermission: AcpClientFactoryOpts['onPermission']
): AcpSessionLike {
  let updateCb: (u: AcpSessionUpdate) => void = () => {}
  return {
    sessionId,
    async prompt(): Promise<void> {
      const script = getScript()
      if (script.throwMidStream) {
        throw new Error('scripted transport failure')
      }
      for (const chunk of script.content ?? []) {
        updateCb({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })
      }
      if (script.toolCall) {
        const decision = await onPermission({
          sessionId,
          toolCall: { toolCallId: 'tc-1', kind: 'execute', rawInput: script.toolCall.input },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
          ]
        })
        if ('optionId' in decision && decision.optionId === 'allow') {
          updateCb({
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: script.toolCall.name,
            kind: 'execute'
          })
          updateCb({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-1',
            status: 'completed',
            rawOutput: { output: 'ran' }
          })
        }
      }
      // Resolves whether or not `completeTurn` was set — the driver threads the synthetic
      // `turn.completed` boundary item on resolution regardless (index.ts's `doPrompt`).
      // Model this scripted single-turn transport as ending the session right after, so
      // `events()` terminates (mirrors Copilot's fake emitting `session.shutdown`). Deferred
      // to a macrotask (not a microtask) so it lands strictly AFTER the driver's own
      // `.then()` — attached to this same `prompt()` promise — has pushed `turn.completed`;
      // a same-tick push would race ahead of it and drop the boundary event.
      setTimeout(() => updateCb({ type: 'session.ended' }), 0)
    },
    async cancel(): Promise<void> {
      /* ignores interrupt — the driver must still resolve interrupt() (invariant 6) */
    },
    onUpdate(cb) {
      updateCb = cb
    }
  }
}

function fakeFactory(): AcpClientFactory {
  return (opts) => {
    const client: AcpClientLike = {
      async start() {
        /* no-op transport */
      },
      async newSession() {
        const id = currentScript.checkpoint ?? DEFAULT_SESSION_ID
        return makeFakeSession(id, () => currentScript, opts.onPermission)
      },
      async loadSession(id) {
        return makeFakeSession(id, () => currentScript, opts.onPermission)
      },
      stop: vi.fn(async () => undefined)
    }
    return client
  }
}

runDriverContractSuite(
  () => createAcpDriver(GROK_PROFILE, { clientFactory: fakeFactory() }),
  (script) => {
    currentScript = script
  }
)

it('declared headlessOneShot matches runHeadless presence', () => {
  const d = createAcpDriver(GROK_PROFILE)
  expect(d.capabilities.headlessOneShot).toBe(false)
  expect(d.runHeadless).toBeUndefined()
})

// resolveDistillProvider (shared/drivers.ts) gates on the SHARED flag; what actually runs
// is the main-side method. If shared says true but the method is absent (or vice versa),
// distillation either silently refuses a working provider or throws on a provider the UI
// claims supports it. All three — shared flag, main-side flag, main-side method — must agree.
it('shared DRIVERS headlessOneShot agrees with the main-process driver flag and method', () => {
  const d = createAcpDriver(GROK_PROFILE)
  expect(DRIVERS[d.kind].capabilities.headlessOneShot).toBe(d.capabilities.headlessOneShot)
  expect(DRIVERS[d.kind].capabilities.headlessOneShot).toBe(typeof d.runHeadless === 'function')
})
