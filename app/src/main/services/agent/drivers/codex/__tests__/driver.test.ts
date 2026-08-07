import { describe, it, expect, vi } from 'vitest'
import { createCodexDriver } from '../index'
import { codexHome } from '../home'
import type { CodexClientFactory, CodexClientLike } from '../client'
import type { AgentEvent } from '../../../../../../shared/agent-events'
import type { DriverSessionContext, TurnResult } from '../../../driver'
import type { NativeToolDeps } from '../../../nativeTools'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

type Notification = { method: string; params?: unknown }
type ServerRequest = { id: number; method: string; params?: unknown }
type ServerRequestCb = (req: ServerRequest) => Promise<unknown>

interface FakeOpts {
  threadId?: string
  /** When set, `thread/resume` rejects with this message (drives resume-fallback). */
  resumeError?: string
  /** Suppress the automatic scripted turn drive on `turn/start` (for targeted bridge tests). */
  noDrive?: boolean
}

interface Fake {
  factory: CodexClientFactory
  calls: string[]
  requests: Array<{ method: string; params?: unknown }>
  stop: ReturnType<typeof vi.fn>
  forceStop: ReturnType<typeof vi.fn>
  /** The onServerRequest handler the driver registered (available after `ready` resolves). */
  serverRequest: () => ServerRequestCb | undefined
  /** Push a raw notification through the driver's onNotification channel. */
  notify: (msg: Notification) => void
  /** Fire the driver's onExit handler — models the app-server child exiting. */
  fireExit: (info?: { code: number | null; signal: string | null }) => void
  /** `env` passed to the most recently spawned client — asserts CODEX_HOME derivation. */
  lastSpawnEnv: () => NodeJS.ProcessEnv | undefined
}

function makeFake(opts: FakeOpts = {}): Fake {
  const calls: string[] = []
  const requests: Array<{ method: string; params?: unknown }> = []
  const stop = vi.fn(async () => undefined)
  const forceStop = vi.fn(async () => undefined)
  const threadId = opts.threadId ?? 'thread-xyz'
  let lastEnv: NodeJS.ProcessEnv | undefined

  let notificationCb: ((msg: Notification) => void) | undefined
  let serverRequestCb: ServerRequestCb | undefined
  let exitCb: ((info?: { code: number | null; signal: string | null }) => void) | undefined

  const notify = (msg: Notification): void => notificationCb?.(msg)
  const fireExit = (info?: { code: number | null; signal: string | null }): void => exitCb?.(info)

  async function drive(): Promise<void> {
    const turnId = 'turn-1'
    notify({
      method: 'turn/started',
      params: { threadId, turn: { id: turnId, status: 'inProgress' } }
    })
    notify({
      method: 'item/agentMessage/delta',
      params: { delta: 'Hello', itemId: 'm1', threadId, turnId }
    })
    notify({
      method: 'item/started',
      params: { threadId, turnId, item: { type: 'commandExecution', id: 'c1', command: 'ls' } }
    })
    if (serverRequestCb) {
      await serverRequestCb({
        id: 1,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'c1', command: 'ls', threadId, turnId }
      })
    }
    notify({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          type: 'commandExecution',
          id: 'c1',
          exitCode: 0,
          aggregatedOutput: 'file-a\nfile-b',
          status: 'completed'
        }
      }
    })
    notify({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed', durationMs: 5 } }
    })
  }

  const factory: CodexClientFactory = (factoryOpts) => {
    lastEnv = factoryOpts.spawn.env
    const client: CodexClientLike = {
      start: async () => {
        calls.push('start')
      },
      request: async (method, params) => {
        calls.push(method)
        requests.push({ method, params })
        if (method === 'initialize')
          return { userAgent: 'codex-cli/0.1', codexHome: '/tmp/codex-home' }
        if (method === 'thread/resume') {
          if (opts.resumeError) throw new Error(opts.resumeError)
          return { thread: { id: threadId } }
        }
        if (method === 'thread/start') return { thread: { id: threadId } }
        if (method === 'turn/start') {
          if (!opts.noDrive) queueMicrotask(() => void drive())
          return { turn: { id: 'turn-1' } }
        }
        if (method === 'turn/interrupt') return {}
        return {}
      },
      notify: (method) => {
        calls.push(`notify:${method}`)
      },
      onNotification: (cb) => {
        notificationCb = cb
      },
      onServerRequest: (cb) => {
        serverRequestCb = cb
      },
      onExit: (cb) => {
        exitCb = cb
      },
      stop,
      forceStop
    }
    return client
  }

  return {
    factory,
    calls,
    requests,
    stop,
    forceStop,
    serverRequest: () => serverRequestCb,
    notify,
    fireExit,
    lastSpawnEnv: () => lastEnv
  }
}

function makeCtx(overrides: Partial<DriverSessionContext> = {}): DriverSessionContext {
  return {
    caseDir: '/tmp/case',
    additionalDirectories: [],
    skills: [],
    subagents: [],
    permissionMode: 'default',
    systemAppend: 'PERSONA',
    extraMcpServers: {},
    nativeToolDeps: { argusHome: '/tmp/argus-home', caseSlug: 'c' } as unknown as NativeToolDeps,
    panelCommandDecls: [],
    resumeCursor: null,
    eventCtx: () => ({ caseId: 1, caseSlug: 'c', sessionId: 1, turnId: 1 }),
    onToolRequest: async () => ({ behavior: 'allow', updatedInput: {} }),
    onCursor: vi.fn(),
    onTurnResult: vi.fn(),
    ...overrides
  }
}

describe('createCodexDriver — capabilities', () => {
  it('declares kind, taxonomy, and the four permission modes', () => {
    const d = createCodexDriver()
    expect(d.kind).toBe('codex')
    expect(Object.keys(d.toolTaxonomy.entries).sort()).toEqual(['read', 'shell', 'write'])
    expect(d.toolTaxonomy.fallback).toBeUndefined()
    expect(d.capabilities.permissionModes.length).toBe(4)
    expect(d.capabilities.editableApprovals).toBe(false)
  })
})

describe('createCodexDriver — scripted session', () => {
  it('runs the handshake, exposes the thread id as cursor, bridges an approval, and streams events in order', async () => {
    const { factory, calls } = makeFake()
    const onToolRequest = vi.fn<DriverSessionContext['onToolRequest']>(async () => ({
      behavior: 'allow',
      updatedInput: {}
    }))
    const onCursor = vi.fn()

    const seen: AgentEvent[] = []
    let turnCompletedYieldedAtResult = -1
    let turnResultArg: TurnResult | undefined
    const onTurnResult = vi.fn((r: TurnResult) => {
      turnResultArg = r
      turnCompletedYieldedAtResult = seen.filter((e) => e.type === 'turn.completed').length
    })

    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx({ onToolRequest, onCursor, onTurnResult }))

    const drained = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()

    await tick() // handshake + thread/start resolve
    expect(onCursor).toHaveBeenCalledWith('thread-xyz')
    // Handshake order: start → initialize → initialized notify → thread/start.
    expect(calls.slice(0, 4)).toEqual(['start', 'initialize', 'notify:initialized', 'thread/start'])

    session.send('do it')
    await tick()
    await tick()
    session.end()
    await drained

    // The approval bridge synthesized a `shell` tool call from the exec approval.
    expect(onToolRequest).toHaveBeenCalledTimes(1)
    expect(onToolRequest.mock.calls[0][0]).toBe('shell')

    const types = seen.map((e) => e.type)
    expect(types).toEqual([
      'content.delta',
      'tool.call.started',
      'tool.call.completed',
      'turn.completed'
    ])

    // Contract invariant 7: onTurnResult fires BEFORE the terminal turn.completed is yielded.
    expect(onTurnResult).toHaveBeenCalledTimes(1)
    expect(turnResultArg?.isError).toBe(false)
    expect(turnCompletedYieldedAtResult).toBe(0)
  })
})

describe('createCodexDriver — diagnostics pid attribution', () => {
  it('reports the spawned child pid to onProcessSpawn', async () => {
    const seen: number[] = []
    const { factory: baseFactory } = makeFake({ noDrive: true })
    const factory: CodexClientFactory = (opts) => {
      opts.onSpawn?.(4242)
      return baseFactory(opts)
    }
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx({ onProcessSpawn: (pid) => seen.push(pid) }))
    void (async () => {
      for await (const _e of session.events()) void _e
    })()
    await tick()
    expect(seen).toEqual([4242])
    session.end()
  })
})

describe('createCodexDriver — developerInstructions (systemAppend)', () => {
  it('forwards a non-empty systemAppend as developerInstructions on thread/start', async () => {
    const { factory, requests } = makeFake({ noDrive: true })
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx({ systemAppend: 'PERSONA TEXT' }))
    void (async () => {
      for await (const _e of session.events()) void _e
    })()
    await tick()

    const start = requests.find((r) => r.method === 'thread/start')
    expect((start?.params as Record<string, unknown> | undefined)?.developerInstructions).toBe(
      'PERSONA TEXT'
    )
    session.end()
  })

  it('omits developerInstructions entirely when systemAppend is empty', async () => {
    const { factory, requests } = makeFake({ noDrive: true })
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx({ systemAppend: '' }))
    void (async () => {
      for await (const _e of session.events()) void _e
    })()
    await tick()

    const start = requests.find((r) => r.method === 'thread/start')
    expect(start?.params).not.toHaveProperty('developerInstructions')
    session.end()
  })
})

describe('createCodexDriver — failed turn boundary', () => {
  it('fires onTurnResult (isError: true) before the terminal turn.completed for a FAILED turn', async () => {
    const { factory, notify } = makeFake({ noDrive: true })
    const onTurnResult = vi.fn()
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx({ onTurnResult }))

    const seen: AgentEvent[] = []
    const drained = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()

    await tick() // handshake + thread/start resolve

    notify({
      method: 'turn/completed',
      params: { threadId: 'thread-xyz', turn: { id: 'turn-1', status: 'failed', durationMs: 3 } }
    })
    await tick()

    expect(onTurnResult).toHaveBeenCalledTimes(1)
    expect(onTurnResult.mock.calls[0][0].isError).toBe(true)

    expect(seen.map((e) => e.type)).toEqual(['turn.completed'])
    expect(seen[0]).toMatchObject({ type: 'turn.completed', payload: { status: 'error' } })

    session.end()
    await drained
  })
})

describe('createCodexDriver — onExit classification', () => {
  // A real crash (non-zero exit, a killing signal, or a spawn error with code null) must
  // surface as a fatal so events() throws rather than hanging on the now-silent stream.
  it('a CRASH exit (non-zero code) makes events() throw (anti-hang)', async () => {
    const { factory, fireExit } = makeFake({ noDrive: true })
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx())
    const drained = (async () => {
      for await (const _e of session.events()) void _e
    })()
    await tick() // handshake + thread/start resolve; onExit registered
    fireExit({ code: 1, signal: null })
    await expect(drained).rejects.toThrow(/Codex app-server exited/)
  })

  it('a signal-kill exit also makes events() throw', async () => {
    const { factory, fireExit } = makeFake({ noDrive: true })
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx())
    const drained = (async () => {
      for await (const _e of session.events()) void _e
    })()
    await tick()
    fireExit({ code: null, signal: 'SIGKILL' })
    await expect(drained).rejects.toThrow()
  })

  // A CLEAN exit (code 0, no signal) is a graceful server-side close — the codex analog of
  // copilot's session.shutdown. events() must END NORMALLY (loop completes, no throw).
  it('a CLEAN exit (code 0, no signal) ends events() WITHOUT throwing', async () => {
    const { factory, notify, fireExit } = makeFake({ noDrive: true })
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx())
    const seen: AgentEvent[] = []
    const drained = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()
    await tick() // handshake + thread/start resolve; onExit registered

    // A completed turn, then a graceful close.
    notify({
      method: 'turn/completed',
      params: { threadId: 'thread-xyz', turn: { id: 'turn-1', status: 'completed', durationMs: 4 } }
    })
    await tick()
    fireExit({ code: 0, signal: null })

    // The loop terminates without throwing — asserted by the await resolving.
    await expect(drained).resolves.toBeUndefined()
    expect(seen.map((e) => e.type)).toContain('turn.completed')
  })
})

describe('createCodexDriver — resume fallback', () => {
  it('falls back to thread/start when thread/resume rejects with a recoverable error', async () => {
    const { factory, calls } = makeFake({ resumeError: 'unknown thread: no such thread id' })
    const onCursor = vi.fn()
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx({ resumeCursor: 'old-thread', onCursor }))
    // start the stream so init errors surface rather than dangling
    const drained = (async () => {
      for await (const _e of session.events()) void _e
    })()
    await tick()
    expect(calls).toContain('thread/resume')
    expect(calls).toContain('thread/start')
    expect(onCursor).toHaveBeenCalledWith('thread-xyz')
    session.end()
    await drained
  })

  it('does NOT fall back (surfaces the error) when the resume error is not recoverable', async () => {
    const { factory, calls } = makeFake({ resumeError: 'internal server error 500' })
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx({ resumeCursor: 'old-thread' }))
    await expect(
      (async () => {
        for await (const _e of session.events()) void _e
      })()
    ).rejects.toThrow('internal server error 500')
    expect(calls).toContain('thread/resume')
    expect(calls).not.toContain('thread/start')
  })
})

describe('createCodexDriver — approval bridge edge cases', () => {
  it('fails closed (throws) for a non-approval server request', async () => {
    const { factory, serverRequest } = makeFake({ noDrive: true })
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx())
    void (async () => {
      for await (const _e of session.events()) void _e
    })()
    await tick()
    const cb = serverRequest()!
    await expect(
      cb({ id: 9, method: 'item/tool/requestUserInput', params: { itemId: 'x' } })
    ).rejects.toThrow()
    session.end()
  })

  it('returns cancel (current gen) when the session was aborted before the approval', async () => {
    const { factory, serverRequest } = makeFake({ noDrive: true })
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx())
    void (async () => {
      for await (const _e of session.events()) void _e
    })()
    await tick()
    await session.interrupt() // aborts the internal signal
    const cb = serverRequest()!
    const decision = await cb({
      id: 10,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'c1', command: 'ls' }
    })
    expect(decision).toEqual({ decision: 'cancel' })
  })

  it('bypassPermissions auto-accepts without opening a card', async () => {
    const { factory, serverRequest } = makeFake({ noDrive: true })
    const onToolRequest = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }))
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(
      makeCtx({ permissionMode: 'bypassPermissions', onToolRequest })
    )
    void (async () => {
      for await (const _e of session.events()) void _e
    })()
    await tick()
    const cb = serverRequest()!
    const decision = await cb({
      id: 11,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'c1', command: 'ls' }
    })
    expect(decision).toEqual({ decision: 'accept' })
    expect(onToolRequest).not.toHaveBeenCalled()
  })
})

describe('codexHome', () => {
  it('returns undefined (no override) so CODEX_HOME is left unset — codex falls back to ~/.codex', () => {
    expect(codexHome()).toBeUndefined()
    expect(codexHome(undefined)).toBeUndefined()
    expect(codexHome('')).toBeUndefined()
    expect(codexHome('   ')).toBeUndefined()
  })

  it('returns the trimmed override when set (opt-in multi-account CODEX_HOME separation)', () => {
    expect(codexHome('/custom/codex')).toBe('/custom/codex')
    expect(codexHome('  /custom/codex  ')).toBe('/custom/codex')
  })
})

describe('createCodexDriver — session CODEX_HOME resolution', () => {
  it('leaves CODEX_HOME unset on the spawn env when no codexHome override is configured', async () => {
    const { factory, lastSpawnEnv } = makeFake({ noDrive: true })
    const driver = createCodexDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx())
    void (async () => {
      for await (const _e of session.events()) void _e
    })()
    await tick()
    expect(lastSpawnEnv()).not.toHaveProperty('CODEX_HOME')
    session.end()
  })

  it('sets CODEX_HOME to the configured override on the spawn env', async () => {
    const { factory, lastSpawnEnv } = makeFake({ noDrive: true })
    const driver = createCodexDriver({ codexHome: 'C:/argus-home/codex-home' } as never, {
      clientFactory: factory
    })
    const session = driver.createSession(makeCtx())
    void (async () => {
      for await (const _e of session.events()) void _e
    })()
    await tick()
    expect(lastSpawnEnv()?.CODEX_HOME).toBe('C:/argus-home/codex-home')
    session.end()
  })
})
