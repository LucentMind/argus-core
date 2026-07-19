import { vi, it, expect } from 'vitest'
import { createCopilotDriver } from '../index'
import type {
  CopilotClientFactory,
  CopilotClientLike,
  CopilotSessionConfig,
  CopilotSessionLike
} from '../client'
import type { RawSdkEvent } from '../normalize'
import { runDriverContractSuite, type TransportScript } from '../../../__tests__/driverContract'

const DEFAULT_SESSION_ID = '33333333-3333-4333-8333-333333333333'

// Copilot script entries are enacted as raw SDK session events. The fake session produces
// nothing until a prompt arrives on send(), then emits one turn per the current script —
// exactly the ordering the contract's invariant 2 pins. Permission requests are routed
// through the sessionConfig.onPermissionRequest the driver installs (invariant 3).
function makeFakeSession(
  sessionId: string,
  getScript: () => TransportScript
): {
  session: CopilotSessionLike
  setPermHandler: (h: CopilotSessionConfig['onPermissionRequest']) => void
} {
  let handler: (e: RawSdkEvent) => void = () => {}
  let permHandler: CopilotSessionConfig['onPermissionRequest'] = async () => ({
    kind: 'approve-once'
  })
  const emit = (type: string, data: unknown): void => handler({ type, data })

  const session: CopilotSessionLike = {
    sessionId,
    on(h) {
      handler = h
      return () => {}
    },
    async send() {
      const script = getScript()
      if (script.throwMidStream) {
        // A non-auth session.error is a fatal stream failure the driver propagates.
        emit('session.error', { errorType: 'runtime', message: 'scripted transport failure' })
        return 'mid'
      }
      emit('assistant.turn_start', { turnId: '0', model: 'gpt-5-mini' })
      for (const text of script.content ?? []) {
        emit('assistant.message_delta', { messageId: 'm1', deltaContent: text })
      }
      if (script.toolCall) {
        const decision = await permHandler(
          { kind: 'custom-tool', toolName: script.toolCall.name, args: script.toolCall.input },
          { sessionId }
        )
        if ((decision as { kind: string }).kind === 'approve-once') {
          emit('tool.execution_start', { toolCallId: 'tc-1', toolName: script.toolCall.name })
          emit('tool.execution_complete', {
            toolCallId: 'tc-1',
            success: true,
            result: { content: 'ran' }
          })
        }
      }
      if (script.completeTurn) {
        emit('assistant.usage', {
          model: 'gpt-5-mini',
          inputTokens: 5,
          outputTokens: 2,
          duration: 10
        })
        emit('assistant.turn_end', { turnId: '0', model: 'gpt-5-mini' })
      }
      // Model this scripted single-turn transport as ending the session so events()
      // terminates (the real runtime emits session.shutdown when the session closes).
      emit('session.shutdown', { reason: 'completed' })
      return 'ok'
    },
    async abort() {
      /* ignores interrupt — the driver must still resolve interrupt() (invariant 6) */
    }
  }
  return { session, setPermHandler: (h) => (permHandler = h) }
}

let currentScript: TransportScript = {}

function fakeFactory(): CopilotClientFactory {
  return () => {
    let lastSetPermHandler: (h: CopilotSessionConfig['onPermissionRequest']) => void = () => {}
    const build = (id: string): CopilotSessionLike => {
      const { session, setPermHandler } = makeFakeSession(id, () => currentScript)
      // The driver installs its permission handler via the session config; capture it.
      lastSetPermHandler = setPermHandler
      return session
    }
    const client: CopilotClientLike = {
      async start() {
        /* no-op transport */
      },
      async createSession(config) {
        const s = build(currentScript.checkpoint ?? DEFAULT_SESSION_ID)
        lastSetPermHandler(config.onPermissionRequest)
        return s
      },
      async resumeSession(id, config) {
        const s = build(id)
        lastSetPermHandler(config.onPermissionRequest)
        return s
      },
      async getAuthStatus() {
        return { isAuthenticated: true, authType: 'gh-cli', login: 'tester' }
      },
      async getStatus() {
        return { version: '1.0.71', protocolVersion: 3 }
      },
      stop: vi.fn(async () => []),
      forceStop: vi.fn(async () => undefined)
    }
    return client
  }
}

runDriverContractSuite(
  () => createCopilotDriver({}, { clientFactory: fakeFactory() }),
  (script) => {
    currentScript = script
  }
)

it('declared headlessOneShot matches runHeadless presence', () => {
  const d = createCopilotDriver()
  expect(d.capabilities.headlessOneShot).toBe(typeof d.runHeadless === 'function')
})
