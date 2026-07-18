import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCopilotDriver, isCopilotAuthErrorMessage } from '../index'
import type {
  CopilotClientFactory,
  CopilotClientLike,
  CopilotSessionConfig,
  CopilotSessionLike
} from '../client'
import type { RawSdkEvent } from '../normalize'
import type { AgentEvent } from '../../../../../../shared/agent-events'
import type { DriverSessionContext, TurnResult } from '../../../driver'
import type { NativeToolDeps } from '../../../nativeTools'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))
const AUTH_MSG =
  'Execution failed: Error: Session was not created with authentication info or custom provider'

interface FakeOpts {
  onEmit?: (emit: (type: string, data: unknown) => void) => void
  authenticated?: boolean
  sessionId?: string
}

function makeFake(opts: FakeOpts = {}): {
  factory: CopilotClientFactory
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  forceStop: ReturnType<typeof vi.fn>
  /** Ordered client-method call log (start/createSession/getAuthStatus/…). */
  calls: string[]
  /** The `SessionConfig` the driver handed to createSession/resumeSession, captured verbatim. */
  sessionConfigs: CopilotSessionConfig[]
} {
  const calls: string[] = []
  const sessionConfigs: CopilotSessionConfig[] = []
  const start = vi.fn(async () => {
    calls.push('start')
  })
  const stop = vi.fn(async () => [] as Error[])
  const forceStop = vi.fn(async () => undefined)
  const factory: CopilotClientFactory = () => {
    const session: CopilotSessionLike = {
      sessionId: opts.sessionId ?? '44444444-4444-4444-8444-444444444444',
      on() {
        return () => {}
      },
      async send() {
        return 'ok'
      },
      async abort() {
        /* no-op */
      }
    }
    let handler: (e: RawSdkEvent) => void = () => {}
    session.on = (h) => {
      handler = h
      return () => {}
    }
    session.send = async () => {
      opts.onEmit?.((type, data) => handler({ type, data }))
      return 'ok'
    }
    const client: CopilotClientLike = {
      start,
      async createSession(config) {
        calls.push('createSession')
        sessionConfigs.push(config)
        return session
      },
      async resumeSession(_id, config) {
        calls.push('resumeSession')
        sessionConfigs.push(config)
        return session
      },
      async getAuthStatus() {
        calls.push('getAuthStatus')
        return opts.authenticated === false
          ? { isAuthenticated: false, statusMessage: 'Not authenticated' }
          : { isAuthenticated: true, authType: 'gh-cli', login: 'JiaweiHan88' }
      },
      async getStatus() {
        return { version: '1.0.71', protocolVersion: 3 }
      },
      stop,
      forceStop
    }
    return client
  }
  return { factory, start, stop, forceStop, calls, sessionConfigs }
}

function makeCtx(overrides: Partial<DriverSessionContext> = {}): DriverSessionContext {
  return {
    caseDir: '/tmp/case',
    additionalDirectories: [],
    permissionMode: 'default',
    systemAppend: 'PERSONA',
    extraMcpServers: {},
    // Enough for buildCopilotTools → argusToolHandlers to construct (it computes caseDir
    // eagerly); the handlers themselves are never invoked in these lifecycle tests.
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

describe('createCopilotDriver — capabilities + auth predicate', () => {
  it('declares the four permission modes, no editable approvals, no cost/mcp support', () => {
    const d = createCopilotDriver()
    expect(d.kind).toBe('github-copilot')
    expect(d.capabilities.editableApprovals).toBe(false)
    expect(d.capabilities.costReporting).toBe(false)
    expect(d.capabilities.mcpConnectors).toBe(false)
    expect(d.capabilities.permissionModes.length).toBe(4)
    // 9B taxonomy: write/read/shell/fetch entries, still fail-closed (no fallback).
    expect(Object.keys(d.toolTaxonomy.entries).sort()).toEqual(['fetch', 'read', 'shell', 'write'])
    expect(d.toolTaxonomy.fallback).toBeUndefined()
  })

  it('isAuthErrorMessage matches the SDK auth substring only', () => {
    expect(isCopilotAuthErrorMessage(AUTH_MSG)).toBe(true)
    expect(createCopilotDriver().isAuthErrorMessage?.(AUTH_MSG)).toBe(true)
    expect(isCopilotAuthErrorMessage('some unrelated error')).toBe(false)
  })
})

describe('createCopilotDriver — session lifecycle', () => {
  it('reports the Copilot sessionId as the cursor and stops the client on end()', async () => {
    const { factory, stop } = makeFake({ sessionId: '55555555-5555-4555-8555-555555555555' })
    const onCursor = vi.fn()
    const driver = createCopilotDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx({ onCursor }))
    await tick() // let async session init resolve
    expect(onCursor).toHaveBeenCalledWith('55555555-5555-4555-8555-555555555555')

    session.end()
    await tick()
    expect(stop).toHaveBeenCalledTimes(1) // no orphaned runtime
  })

  it('routes a typed authentication session.error to onTurnResult(authFailure) and surfaces it', async () => {
    const { factory } = makeFake({
      onEmit: (emit) => {
        emit('session.error', { errorType: 'authentication', message: AUTH_MSG })
        emit('assistant.idle', { aborted: false })
      }
    })
    const onTurnResult = vi.fn<(r: TurnResult) => void>()
    const driver = createCopilotDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx({ onTurnResult }))

    const seen: AgentEvent[] = []
    const drained = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()
    await tick()
    session.send('go')
    await tick()
    session.end()
    await drained

    expect(onTurnResult).toHaveBeenCalledTimes(1)
    expect(onTurnResult.mock.calls[0][0].authFailure).toBe(true)
    expect(seen.some((e) => e.type === 'session.error')).toBe(true)
  })

  it('stops the client when events() terminates via the crash path (no end() call)', async () => {
    // Mirrors CaseSession.consume(): the harness catches the thrown stream error, marks
    // the session dead, and never calls end() — the driver alone must reap the runtime.
    const { factory, stop, forceStop } = makeFake({
      onEmit: (emit) => {
        emit('session.error', { errorType: 'runtime', message: 'scripted fatal failure' })
      }
    })
    const driver = createCopilotDriver({}, { clientFactory: factory })
    const session = driver.createSession(makeCtx())
    await tick()
    session.send('go')

    await expect(
      (async () => {
        for await (const e of session.events()) void e
      })()
    ).rejects.toThrow('scripted fatal failure')

    await tick() // stopClient chains on the (already-resolved) init promise
    expect(stop.mock.calls.length + forceStop.mock.calls.length).toBeGreaterThan(0)
    expect(stop).toHaveBeenCalledTimes(1) // graceful stop, no double teardown
  })

  it('awaits client.start() before createSession (session) and getAuthStatus (probe)', async () => {
    const sessionFake = makeFake()
    const driver = createCopilotDriver({}, { clientFactory: sessionFake.factory })
    const s = driver.createSession(makeCtx())
    await tick()
    expect(sessionFake.calls).toEqual(['start', 'createSession'])
    s.end()

    const probeFake = makeFake()
    await createCopilotDriver({}, { clientFactory: probeFake.factory }).probeAuth({})
    expect(probeFake.calls).toEqual(['start', 'getAuthStatus'])
  })

  it('unhandledRejection trap swallows only auth-shaped rejections and rethrows the rest', async () => {
    const { factory } = makeFake()
    const driver = createCopilotDriver({}, { clientFactory: factory })

    const before = process.listeners('unhandledRejection')
    const session = driver.createSession(makeCtx())
    const after = process.listeners('unhandledRejection')
    const trap = after.find((l) => !before.includes(l))!
    expect(trap).toBeDefined()

    // A second session must NOT stack a duplicate listener (ref-counted single trap):
    // duplicates would each rethrow the same unrelated rejection.
    const session2 = driver.createSession(makeCtx())
    expect(process.listeners('unhandledRejection').length).toBe(after.length)

    // Capture the deferred rethrow instead of letting it become a real uncaughtException.
    const deferred: Array<() => void> = []
    const spy = vi
      .spyOn(globalThis, 'setImmediate')
      .mockImplementation(((cb: () => void) => deferred.push(cb)) as never)
    try {
      trap(new Error(AUTH_MSG), Promise.resolve())
      expect(deferred).toHaveLength(0) // auth-shaped: swallowed

      const unrelated = new Error('connector 401, nothing to do with copilot auth')
      trap(unrelated, Promise.resolve())
      expect(deferred).toHaveLength(1) // everything else: rethrown on a fresh tick
      expect(() => deferred[0]()).toThrow(unrelated)
    } finally {
      spy.mockRestore()
    }

    // Ending both sessions releases the single listener.
    session.end()
    session2.end()
    await tick()
    expect(process.listeners('unhandledRejection').includes(trap)).toBe(false)
  })
})

describe('createCopilotDriver — skillDirectories (Task 10)', () => {
  it('passes skillDirectories:[<caseDir>/.claude/skills] when the dir exists (EVIDENCE §11b: NATIVE-LOADS)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-copilot-skills-'))
    const skillsDir = path.join(tmp, '.claude', 'skills')
    fs.mkdirSync(skillsDir, { recursive: true })
    try {
      const { factory, sessionConfigs } = makeFake()
      const driver = createCopilotDriver({}, { clientFactory: factory })
      const session = driver.createSession(makeCtx({ caseDir: tmp }))
      await tick()
      expect(sessionConfigs).toHaveLength(1)
      expect(sessionConfigs[0].skillDirectories).toEqual([skillsDir])
      session.end()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('omits skillDirectories when the case has no .claude/skills dir', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-copilot-skills-'))
    try {
      const { factory, sessionConfigs } = makeFake()
      const driver = createCopilotDriver({}, { clientFactory: factory })
      const session = driver.createSession(makeCtx({ caseDir: tmp }))
      await tick()
      expect(sessionConfigs).toHaveLength(1)
      expect(sessionConfigs[0].skillDirectories).toBeUndefined()
      session.end()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('same wiring applies on resumeSession', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-copilot-skills-'))
    const skillsDir = path.join(tmp, '.claude', 'skills')
    fs.mkdirSync(skillsDir, { recursive: true })
    try {
      const { factory, sessionConfigs } = makeFake()
      const driver = createCopilotDriver({}, { clientFactory: factory })
      const session = driver.createSession(
        makeCtx({ caseDir: tmp, resumeCursor: 'prior-session-id' })
      )
      await tick()
      expect(sessionConfigs).toHaveLength(1)
      expect(sessionConfigs[0].skillDirectories).toEqual([skillsDir])
      session.end()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('createCopilotDriver — probeAuth', () => {
  it('reports ready with login in detail (never the email field) + CLI version', async () => {
    const { factory, stop } = makeFake({ authenticated: true })
    const res = await createCopilotDriver({}, { clientFactory: factory }).probeAuth({})
    expect(res.ok).toBe(true)
    expect(res.detail).toContain('JiaweiHan88')
    expect(res.detail).toContain('gh-cli')
    expect(res.email).toBeUndefined() // login is NOT an email — never lie
    expect(res.version).toBe('1.0.71')
    expect(stop).toHaveBeenCalled() // probe client is torn down
  })

  it('reports not-ok when unauthenticated', async () => {
    const { factory } = makeFake({ authenticated: false })
    const res = await createCopilotDriver({}, { clientFactory: factory }).probeAuth({})
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('Not authenticated')
  })

  it('bounds a wedged start(): times out after timeoutMs and still reaps the client', async () => {
    const stop = vi.fn(async () => [] as Error[])
    const forceStop = vi.fn(async () => undefined)
    const factory: CopilotClientFactory = () =>
      ({
        start: () => new Promise<void>(() => {}), // never resolves
        async getAuthStatus() {
          return { isAuthenticated: true }
        },
        async getStatus() {
          return { version: '1' }
        },
        createSession: async () => ({}) as unknown as CopilotSessionLike,
        resumeSession: async () => ({}) as unknown as CopilotSessionLike,
        stop,
        forceStop
      }) as CopilotClientLike
    const res = await createCopilotDriver({}, { clientFactory: factory }).probeAuth({
      timeoutMs: 30
    })
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('Copilot probe timed out after 30ms')
    expect(stop).toHaveBeenCalled() // client reaped despite the wedged start()
  })

  it('maps an ENOENT/spawn-shaped failure to an actionable detail', async () => {
    const factory: CopilotClientFactory = () =>
      ({
        start: async () => {
          throw Object.assign(new Error('spawn copilot ENOENT'), { code: 'ENOENT' })
        },
        async getAuthStatus() {
          return { isAuthenticated: true }
        },
        async getStatus() {
          return { version: '1' }
        },
        createSession: async () => ({}) as unknown as CopilotSessionLike,
        resumeSession: async () => ({}) as unknown as CopilotSessionLike,
        stop: vi.fn(async () => [] as Error[]),
        forceStop: vi.fn(async () => undefined)
      }) as CopilotClientLike
    const res = await createCopilotDriver({}, { clientFactory: factory }).probeAuth({})
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('Copilot runtime not found')
  })
})
