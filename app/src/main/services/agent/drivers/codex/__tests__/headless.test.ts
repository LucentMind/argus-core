import { describe, it, expect, vi } from 'vitest'
import { runCodexHeadless } from '../headless'
import type { CodexClientFactory, CodexClientLike } from '../client'

type Notification = { method: string; params?: unknown }
type ServerRequestCb = (req: { id: number; method: string; params?: unknown }) => Promise<unknown>

/** A scripted app-server client: exposes `notify` to push notifications into the driver's
 *  `onNotification` channel from the test, and captures the `onServerRequest` handler the
 *  headless run registered so a test can invoke it directly. */
function scriptedClient(): {
  factory: CodexClientFactory
  notify: (msg: Notification) => void
  serverRequest: () => ServerRequestCb | undefined
  stop: ReturnType<typeof vi.fn>
  forceStop: ReturnType<typeof vi.fn>
  spawnArgs: () => { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined
} {
  let notificationCb: ((msg: Notification) => void) | undefined
  let serverRequestCb: ServerRequestCb | undefined
  let spawnArgs: { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined
  const stop = vi.fn(async () => undefined)
  const forceStop = vi.fn(async () => undefined)
  // Buffer notifications sent by a test before `onNotification` registers (real wire
  // callers await `start()`/`initialize` first, so registration is asynchronous relative
  // to when a test schedules its scripted notifications).
  const backlog: Notification[] = []

  const factory: CodexClientFactory = (opts) => {
    spawnArgs = opts.spawn
    const client: CodexClientLike = {
      start: async () => undefined,
      request: async (method) => {
        if (method === 'initialize') return { userAgent: 'codex-cli/0.1' }
        if (method === 'thread/start') return { thread: { id: 'thread-1' } }
        if (method === 'turn/start') return { turn: { id: 'turn-1' } }
        return {}
      },
      notify: () => undefined,
      onNotification: (cb) => {
        notificationCb = cb
        while (backlog.length > 0) cb(backlog.shift() as Notification)
      },
      onServerRequest: (cb) => {
        serverRequestCb = cb
      },
      stop,
      forceStop
    }
    return client
  }

  return {
    factory,
    notify: (msg: Notification) => {
      if (notificationCb) notificationCb(msg)
      else backlog.push(msg)
    },
    serverRequest: () => serverRequestCb,
    stop,
    forceStop,
    spawnArgs: () => spawnArgs
  }
}

/** Push the happy-path notification sequence a beat after `turn/start` resolves, mirroring
 *  the real wire ordering (deltas, then the terminal `turn/completed`). */
function driveHappyPath(c: ReturnType<typeof scriptedClient>, texts: string[]): void {
  queueMicrotask(() => {
    for (const t of texts) {
      c.notify({ method: 'item/agentMessage/delta', params: { delta: t, itemId: 'm1' } })
    }
    c.notify({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })
  })
}

describe('codex runCodexHeadless', () => {
  it('concatenates agentMessage deltas and resolves on turn/completed', async () => {
    const c = scriptedClient()
    driveHappyPath(c, ['Hello', ' world'])
    const text = await runCodexHeadless('prompt', { argusHome: '/tmp/argus' }, c.factory)
    expect(text).toBe('Hello world')
    expect(c.stop).toHaveBeenCalledTimes(1)
    expect(c.forceStop).not.toHaveBeenCalled()
  })

  it("spawns codex app-server with CODEX_HOME left unset (falls back to codex's own ~/.codex default), and declines current-gen server requests", async () => {
    const c = scriptedClient()
    driveHappyPath(c, ['ok'])
    await runCodexHeadless('prompt', { argusHome: '/tmp/argus' }, c.factory)
    const spawn = c.spawnArgs()
    expect(spawn?.command).toBe('codex')
    expect(spawn?.args).toEqual(['app-server'])
    expect(spawn?.env).not.toHaveProperty('CODEX_HOME')

    const decision = await c.serverRequest()?.({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: {}
    })
    expect(decision).toEqual({ decision: 'decline' })
  })

  it('denies legacy-gen server requests with the legacy vocabulary ("denied", not "decline")', async () => {
    const c = scriptedClient()
    driveHappyPath(c, ['ok'])
    await runCodexHeadless('prompt', { argusHome: '/tmp/argus' }, c.factory)

    const decision = await c.serverRequest()?.({
      id: 8,
      method: 'execCommandApproval',
      params: {}
    })
    expect(decision).toEqual({ decision: 'denied' })
  })

  it('fails closed (rejects) on a non-approval server request', async () => {
    const c = scriptedClient()
    driveHappyPath(c, ['ok'])
    await runCodexHeadless('prompt', { argusHome: '/tmp/argus' }, c.factory)

    await expect(
      c.serverRequest()?.({
        id: 9,
        method: 'item/tool/requestUserInput',
        params: {}
      })
    ).rejects.toThrow(/unsupported server request/)
  })

  it('uses cliPath override when supplied', async () => {
    const c = scriptedClient()
    driveHappyPath(c, ['ok'])
    await runCodexHeadless('prompt', { argusHome: '/tmp/argus' }, c.factory, '/custom/codex')
    expect(c.spawnArgs()?.command).toBe('/custom/codex')
  })

  it('rejects when the timeout elapses first, and reaps the client', async () => {
    const c = scriptedClient()
    // never notify turn/completed
    await expect(
      runCodexHeadless('prompt', { argusHome: '/tmp/argus', timeoutMs: 30 }, c.factory)
    ).rejects.toThrow(/timed out after 30ms/)
    expect(c.forceStop).toHaveBeenCalledTimes(1)
  })

  it('throws on turn/completed with status "failed"', async () => {
    const c = scriptedClient()
    queueMicrotask(() => {
      c.notify({ method: 'item/agentMessage/delta', params: { delta: 'partial', itemId: 'm1' } })
      c.notify({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'failed' } } })
    })
    await expect(
      runCodexHeadless('prompt', { argusHome: '/tmp/argus' }, c.factory)
    ).rejects.toThrow()
    expect(c.stop).toHaveBeenCalledTimes(1)
  })

  it('throws on turn/completed with status "interrupted"', async () => {
    const c = scriptedClient()
    queueMicrotask(() => {
      c.notify({
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'interrupted' } }
      })
    })
    await expect(
      runCodexHeadless('prompt', { argusHome: '/tmp/argus' }, c.factory)
    ).rejects.toThrow()
  })

  it('throws on a non-retryable error notification', async () => {
    const c = scriptedClient()
    queueMicrotask(() => {
      c.notify({
        method: 'error',
        params: { willRetry: false, error: { message: 'boom' } }
      })
    })
    await expect(
      runCodexHeadless('prompt', { argusHome: '/tmp/argus' }, c.factory)
    ).rejects.toThrow(/boom/)
  })

  it('ignores a retryable (willRetry:true) error notification and keeps waiting', async () => {
    const c = scriptedClient()
    queueMicrotask(() => {
      c.notify({ method: 'error', params: { willRetry: true, error: { message: 'transient' } } })
      c.notify({ method: 'item/agentMessage/delta', params: { delta: 'ok', itemId: 'm1' } })
      c.notify({
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed' } }
      })
    })
    const text = await runCodexHeadless('prompt', { argusHome: '/tmp/argus' }, c.factory)
    expect(text).toBe('ok')
  })

  it('throws when turn/completed carries no assistant text', async () => {
    const c = scriptedClient()
    queueMicrotask(() => {
      c.notify({
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed' } }
      })
    })
    await expect(
      runCodexHeadless('prompt', { argusHome: '/tmp/argus' }, c.factory)
    ).rejects.toThrow(/no text/)
  })

  it('also accumulates text from item/completed agentMessage when no deltas preceded it', async () => {
    const c = scriptedClient()
    queueMicrotask(() => {
      c.notify({
        method: 'item/completed',
        params: { item: { type: 'agentMessage', id: 'm1', text: 'final text' } }
      })
      c.notify({
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed' } }
      })
    })
    const text = await runCodexHeadless('prompt', { argusHome: '/tmp/argus' }, c.factory)
    expect(text).toBe('final text')
  })
})
