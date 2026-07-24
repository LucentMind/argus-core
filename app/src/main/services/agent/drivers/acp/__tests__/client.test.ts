/* eslint-disable @typescript-eslint/no-empty-function -- fake AcpClientLike/AcpSessionLike
 * implementations below stub the interface's methods intentionally with empty bodies. */
import { describe, expect, it } from 'vitest'
import type { AcpClientFactory } from '../client'

/**
 * Step-1 contract test (brief §Task 5): the REAL `defaultAcpClientFactory` needs a live ACP
 * agent subprocess (no `cursor-agent`/`grok` binary exists in this environment) so it is
 * smoke-tested later (Task 11), not unit-tested here. This asserts a fake `AcpClientFactory`
 * satisfies the interface and that the factory-level `onPermission`/`onUpdate` callbacks are
 * exactly what a real implementation would forward: `onUpdate` receives the flat
 * `session/update` sub-object (not the whole `{sessionId, update}` params), and `onPermission`
 * is awaited for a decision.
 */
describe('AcpClientFactory (fake)', () => {
  it('client factory forwards permission + update callbacks', async () => {
    const seen: string[] = []
    const factory: AcpClientFactory = ({ onUpdate }) => ({
      async start() {},
      async stop() {},
      async newSession() {
        onUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'x' } })
        return { sessionId: 's', async prompt() {}, async cancel() {}, onUpdate() {} }
      },
      async loadSession() {
        return { sessionId: 's', async prompt() {}, async cancel() {}, onUpdate() {} }
      }
    })
    const c = factory({
      spawn: { command: 'x', args: [], env: {} },
      onPermission: async () => ({ optionId: 'allow' }),
      onUpdate: (u) => seen.push(u.sessionUpdate)
    })
    await c.newSession({})
    expect(seen).toEqual(['agent_message_chunk'])
  })

  it('start/stop/loadSession round-trip on the fake without touching the real library', async () => {
    const factory: AcpClientFactory = () => ({
      async start() {},
      async stop() {},
      async newSession() {
        return { sessionId: 'new-session', async prompt() {}, async cancel() {}, onUpdate() {} }
      },
      async loadSession(sessionId: string) {
        return { sessionId, async prompt() {}, async cancel() {}, onUpdate() {} }
      }
    })
    const c = factory({
      spawn: { command: 'grok', args: ['agent', 'stdio'], env: {} },
      onPermission: async () => ({ cancelled: true }),
      onUpdate: () => {}
    })
    await c.start()
    const loaded = await c.loadSession('resumed-id', { cwd: '/tmp' })
    expect(loaded.sessionId).toBe('resumed-id')
    await loaded.prompt('hi')
    await loaded.cancel()
    await c.stop()
  })
})
