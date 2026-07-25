/* eslint-disable @typescript-eslint/no-empty-function -- fake AcpClientLike/AcpSessionLike
 * implementations below stub the interface's methods intentionally with empty bodies. */
import type { SessionNotification } from '@zed-industries/agent-client-protocol'
import { describe, expect, it, vi } from 'vitest'
import { defaultAcpClientFactory, routeSessionUpdate, type AcpClientFactory } from '../client'

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

/**
 * Fix (review): `Client.sessionUpdate` used to fire BOTH the factory-level `opts.onUpdate` AND
 * any per-session `AcpSessionLike.onUpdate` callback for the same notification, which would
 * double-deliver every event once Task 6's driver registers a per-session callback (duplicated
 * transcript entries). `routeSessionUpdate` is the extracted, exported routing function
 * `defaultAcpClientFactory`'s real `Client.sessionUpdate` delegates to — testing it directly
 * exercises the actual precedence logic without needing a live ACP agent subprocess (which
 * `defaultAcpClientFactory` as a whole still requires — see the Step-1 comment above).
 */
describe('routeSessionUpdate (single authoritative delivery path)', () => {
  it('delivers ONLY to the per-session callback when one is registered — no double delivery', () => {
    const perSessionSeen: unknown[] = []
    const factorySeen: unknown[] = []
    const callbacks = new Map<string, (update: unknown) => void>([
      ['s1', (u) => perSessionSeen.push(u)]
    ])
    const params = {
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } }
    } as SessionNotification

    routeSessionUpdate(params, callbacks, (u) => factorySeen.push(u))

    expect(perSessionSeen).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } }
    ])
    expect(factorySeen).toEqual([])
  })

  it('falls back to the factory-level callback when no per-session callback is registered', () => {
    const factorySeen: unknown[] = []
    const callbacks = new Map<string, (update: unknown) => void>()
    const params = {
      sessionId: 'unregistered',
      update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } }
    } as SessionNotification

    routeSessionUpdate(params, callbacks, (u) => factorySeen.push(u))

    expect(factorySeen).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } }])
  })

  it("doesn't leak updates across sessions: a callback registered for a different sessionId doesn't fire", () => {
    const otherSessionSeen: unknown[] = []
    const factorySeen: unknown[] = []
    const callbacks = new Map<string, (update: unknown) => void>([
      ['s-other', (u) => otherSessionSeen.push(u)]
    ])
    const params = {
      sessionId: 's-target',
      update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } }
    } as SessionNotification

    routeSessionUpdate(params, callbacks, (u) => factorySeen.push(u))

    expect(otherSessionSeen).toEqual([])
    expect(factorySeen).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } }])
  })
})

/**
 * Fix (review): `stop()` used to send SIGTERM and resolve immediately without confirming the
 * child actually exited. These exercise the REAL `defaultAcpClientFactory`'s `stop()` against a
 * real (non-ACP) child process — `stop()` only touches child-process lifecycle, not the ACP
 * protocol, so this doesn't need a live ACP agent binary (unlike `start()`/`newSession()`,
 * which remain smoke-tested only, per the Step-1 comment above).
 */
describe('defaultAcpClientFactory stop() (real child process)', () => {
  it('resolves once the real spawned child has actually exited', async () => {
    const c = defaultAcpClientFactory({
      spawn: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {} },
      onPermission: async () => ({ cancelled: true }),
      onUpdate: () => {}
    })
    await c.stop()
    // A second stop() must be a no-op (exitCode/signalCode already set) rather than erroring.
    await c.stop()
  }, 10000)

  it('is a no-op when the child has already exited on its own', async () => {
    const c = defaultAcpClientFactory({
      spawn: { command: process.execPath, args: ['-e', 'process.exit(0)'], env: {} },
      onPermission: async () => ({ cancelled: true }),
      onUpdate: () => {}
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await c.stop()
  }, 10000)
})

/**
 * Fix (review of Task 9): `defaultAcpClientFactory` spawned the agent child with no
 * `child.on('exit', ...)` wiring at all — if the agent process crashed or exited mid-session,
 * nothing ever terminated the driver's `events()` stream (no fatal item, no clean end): it just
 * hung forever awaiting a `session/update` that would never arrive. These exercise the REAL
 * `defaultAcpClientFactory` against a real (non-ACP) child process that exits on its own after a
 * short, fixed delay — deliberately NOT awaiting `start()` (the dummy child never completes the
 * ACP handshake) since only child-process lifecycle is under test here, same rationale as the
 * `stop()` describe block above.
 */
describe('defaultAcpClientFactory child-exit hardening', () => {
  it('an unexpected child exit delivers a synthetic {type:"error"} item to onUpdate', async () => {
    const updates: unknown[] = []
    defaultAcpClientFactory({
      spawn: {
        command: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(1), 50)'],
        env: {}
      },
      onPermission: async () => ({ cancelled: true }),
      onUpdate: (u) => updates.push(u)
    })
    // start() is deliberately not awaited/called — the dummy child never speaks ACP.
    // POLL, don't sleep a fixed budget. The old `setTimeout(250)` had to cover a REAL
    // node process spawn plus its 50ms timer plus exit delivery; under full-suite parallel
    // load a cold spawn alone can exceed that, so the test failed for scheduling reasons
    // rather than behaviour (reproduced on a pristine tree by running this file under CPU
    // load). Explicit generous bounds, matching the subprocess-poll convention used
    // elsewhere in the suite — vitest's defaults are what flake here.
    await vi.waitFor(() => expect(updates).toHaveLength(1), { timeout: 15_000, interval: 25 })

    const item = updates[0] as { type: string; message: string }
    expect(item.type).toBe('error')
    expect(item.message).toMatch(/exited unexpectedly/i)
    expect(item.message).toMatch(/code=1/)
  }, 30_000)

  it('a child exit after stop() delivers NO error item (expected teardown, not a crash)', async () => {
    const updates: unknown[] = []
    const c = defaultAcpClientFactory({
      spawn: {
        command: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(1), 50)'],
        env: {}
      },
      onPermission: async () => ({ cancelled: true }),
      onUpdate: (u) => updates.push(u)
    })
    await c.stop() // sets `stopping` before signaling the child, then confirms exit
    // Give any (incorrect) late delivery a chance to land before asserting nothing arrived.
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(updates).toEqual([])
  }, 10000)
})
