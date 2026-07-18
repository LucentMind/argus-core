import { describe, it, expect, vi } from 'vitest'
import { createCopilotDriver, isCopilotAuthErrorMessage } from '../index'
import type { CopilotClientFactory, CopilotClientLike, CopilotSessionLike } from '../client'
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
  stop: ReturnType<typeof vi.fn>
  forceStop: ReturnType<typeof vi.fn>
} {
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
      async start() {
        /* no-op transport */
      },
      async createSession() {
        return session
      },
      async resumeSession() {
        return session
      },
      async getAuthStatus() {
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
  return { factory, stop, forceStop }
}

function makeCtx(overrides: Partial<DriverSessionContext> = {}): DriverSessionContext {
  return {
    caseDir: '/tmp/case',
    additionalDirectories: [],
    permissionMode: 'default',
    systemAppend: 'PERSONA',
    extraMcpServers: {},
    nativeToolDeps: { argusHome: '/tmp/argus-home' } as unknown as NativeToolDeps,
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
  it('declares the four permission modes, no editable approvals, no cost reporting', () => {
    const d = createCopilotDriver()
    expect(d.kind).toBe('github-copilot')
    expect(d.capabilities.editableApprovals).toBe(false)
    expect(d.capabilities.costReporting).toBe(false)
    expect(d.capabilities.permissionModes.length).toBe(4)
    // 9A taxonomy is a fail-closed stub: no entries, no fallback.
    expect(d.toolTaxonomy.entries).toEqual({})
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
})
