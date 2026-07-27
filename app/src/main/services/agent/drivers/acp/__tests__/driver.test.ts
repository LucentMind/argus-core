/* eslint-disable @typescript-eslint/no-empty-function -- fake AcpClientLike/AcpSessionLike
 * implementations below stub unused interface methods intentionally with empty bodies. */
import { describe, it, expect, vi } from 'vitest'
import { createAcpDriver, decisionToOptionId, isAcpAuthErrorMessage } from '../index'
import type {
  AcpClientFactory,
  AcpPermissionDecision,
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpSessionUpdate
} from '../client'
import type { AcpAgentProfile } from '../profiles/types'
import type { DriverSessionContext, TurnResult } from '../../../driver'
import type { AgentEvent } from '../../../../../../shared/agent-events'
import type { NativeToolDeps } from '../../../nativeTools'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

const PROFILE: AcpAgentProfile = {
  kind: 'cursor',
  displayName: 'Cursor',
  spawn: () => ({ command: 'cursor-agent', args: ['acp'], env: { PATH: '/usr/bin' } }),
  auth: { envVar: 'CURSOR_API_KEY', loginHint: 'Run `cursor-agent login`.' },
  models: [{ slug: 'auto', name: 'Auto' }]
}

const ALLOW_REJECT_OPTIONS: AcpPermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' }
]

interface Fake {
  factory: AcpClientFactory
  calls: string[]
  getPermissionHandler: () => (req: AcpPermissionRequest) => Promise<AcpPermissionDecision>
  getUpdateCb: () => (u: AcpSessionUpdate) => void
  resolvePrompt: () => void
  rejectPrompt: (err: unknown) => void
  stop: ReturnType<typeof vi.fn>
}

function makeFake(sessionId = 'sess-1'): Fake {
  const calls: string[] = []
  let permissionHandler: ((req: AcpPermissionRequest) => Promise<AcpPermissionDecision>) | null =
    null
  let updateCb: ((u: AcpSessionUpdate) => void) | null = null
  let resolveFn: (() => void) | null = null
  let rejectFn: ((err: unknown) => void) | null = null
  const stop = vi.fn(async () => {
    calls.push('stop')
  })

  const factory: AcpClientFactory = (opts) => {
    permissionHandler = opts.onPermission
    return {
      async start() {
        calls.push('start')
      },
      async newSession(cfg) {
        calls.push(`newSession:${JSON.stringify(cfg)}`)
        return {
          sessionId,
          async prompt(text: string) {
            calls.push(`prompt:${text}`)
            return new Promise<void>((resolve, reject) => {
              resolveFn = resolve
              rejectFn = reject
            })
          },
          async cancel() {
            calls.push('cancel')
          },
          onUpdate(cb) {
            updateCb = cb
          }
        }
      },
      async loadSession(id: string) {
        calls.push(`loadSession:${id}`)
        return {
          sessionId: id,
          async prompt() {
            return new Promise<void>(() => {})
          },
          async cancel() {},
          onUpdate(cb) {
            updateCb = cb
          }
        }
      },
      stop
    }
  }

  return {
    factory,
    calls,
    getPermissionHandler: () => {
      if (!permissionHandler) throw new Error('onPermission not registered yet')
      return permissionHandler
    },
    getUpdateCb: () => {
      if (!updateCb) throw new Error('onUpdate not registered yet')
      return updateCb
    },
    resolvePrompt: () => resolveFn?.(),
    rejectPrompt: (err) => rejectFn?.(err),
    stop
  }
}

function makeCtx(overrides: Partial<DriverSessionContext> = {}): DriverSessionContext {
  return {
    caseDir: '/tmp/case',
    additionalDirectories: [],
    skills: [],
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

describe('createAcpDriver — capabilities + auth predicate', () => {
  it('declares kind/taxonomy/capabilities from the profile, matching the shared catalog byte-for-byte', () => {
    const d = createAcpDriver(PROFILE)
    expect(d.kind).toBe('cursor')
    expect(d.authFixHint).toBe('Run `cursor-agent login`.')
    expect(d.capabilities).toEqual({
      permissionModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
      editableApprovals: false,
      costReporting: false,
      planMode: true,
      mcpConnectors: false,
      headlessOneShot: false,
      systemPromptTransport: 'none',
      subagents: 'promptable'
    })
    expect(Object.keys(d.toolTaxonomy.entries).sort()).toEqual(['fetch', 'read', 'shell', 'write'])
    expect(d.runHeadless).toBeUndefined()
  })

  it('isAuthErrorMessage matches an auth-shaped message only', () => {
    expect(isAcpAuthErrorMessage('Unauthorized: invalid API key')).toBe(true)
    expect(createAcpDriver(PROFILE).isAuthErrorMessage?.('unauthorized')).toBe(true)
    expect(isAcpAuthErrorMessage('disk full')).toBe(false)
  })

  it('declares transport "none" and reports it — the systemAppend drop is asserted, not hidden', () => {
    // This test DOCUMENTS a known gap. When the plan that forwards the persona as a first-turn
    // preamble lands, this expectation flips to that transport rather than being deleted.
    const forwarded: Array<{ transport: string }> = []
    const d = createAcpDriver(PROFILE, { clientFactory: makeFake().factory })
    expect(d.capabilities.systemPromptTransport).toBe('none')
    d.createSession(
      makeCtx({
        systemAppend: 'PERSONA',
        capturePrompt: (f) => {
          forwarded.push(f)
        }
      })
    )
    expect(forwarded).toEqual([{ transport: 'none' }])
  })
})

describe('mcpConnectors:false degradation — session.mcp.skipped', () => {
  it('emits one session.mcp.skipped per composed connector at session start', async () => {
    const fake = makeFake()
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    const session = driver.createSession(
      makeCtx({ extraMcpServers: { atlassian: {}, github: {} } })
    )
    const seen: AgentEvent[] = []
    const drained = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()
    await tick()
    session.end()
    await drained

    const skips = seen.filter((e) => e.type === 'session.mcp.skipped')
    expect(
      skips.map((s) => (s.type === 'session.mcp.skipped' ? s.payload.instanceId : null)).sort()
    ).toEqual(['atlassian', 'github'])
    for (const s of skips) {
      if (s.type === 'session.mcp.skipped') {
        expect(s.payload.reason).toBe('ACP driver does not yet forward MCP connectors')
      }
    }
  })

  it('emits no session.mcp.skipped events when extraMcpServers is empty', async () => {
    const fake = makeFake()
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    const session = driver.createSession(makeCtx())
    const seen: AgentEvent[] = []
    const drained = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()
    await tick()
    session.end()
    await drained

    expect(seen.filter((e) => e.type === 'session.mcp.skipped')).toEqual([])
  })
})

describe('decisionToOptionId', () => {
  it('allow prefers allow_once, else allow_always, else the first option', () => {
    expect(
      decisionToOptionId({ behavior: 'allow', updatedInput: {} }, ALLOW_REJECT_OPTIONS)
    ).toEqual({
      optionId: 'allow-once'
    })
    expect(
      decisionToOptionId({ behavior: 'allow', updatedInput: {} }, [ALLOW_REJECT_OPTIONS[1]])
    ).toEqual({ optionId: 'allow-always' })
    const onlyReject = [ALLOW_REJECT_OPTIONS[2]]
    expect(decisionToOptionId({ behavior: 'allow', updatedInput: {} }, onlyReject)).toEqual({
      optionId: 'reject-once'
    })
  })

  it('deny prefers reject_once, else reject_always, else cancelled when no reject option exists', () => {
    expect(decisionToOptionId({ behavior: 'deny', message: 'no' }, ALLOW_REJECT_OPTIONS)).toEqual({
      optionId: 'reject-once'
    })
    expect(
      decisionToOptionId({ behavior: 'deny', message: 'no' }, [ALLOW_REJECT_OPTIONS[3]])
    ).toEqual({ optionId: 'reject-always' })
    expect(
      decisionToOptionId({ behavior: 'deny', message: 'no' }, [ALLOW_REJECT_OPTIONS[0]])
    ).toEqual({ cancelled: true })
  })
})

describe('createAcpDriver — permission bridge', () => {
  it('synthesizes name/input from the ACP tool kind + rawInput, calls onToolRequest, and maps allow to an allow optionId', async () => {
    const onToolRequest = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }))
    const fake = makeFake()
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    const session = driver.createSession(makeCtx({ onToolRequest }))
    await tick()

    const handler = fake.getPermissionHandler()
    const decision = await handler({
      sessionId: 'sess-1',
      toolCall: { toolCallId: 't1', kind: 'execute', title: 'ls', rawInput: { command: 'ls -la' } },
      options: ALLOW_REJECT_OPTIONS
    })

    expect(onToolRequest).toHaveBeenCalledWith('shell', { command: 'ls -la' }, expect.any(Object))
    expect(decision).toEqual({ optionId: 'allow-once' })
    session.end()
  })

  it('maps a deny decision to a reject optionId', async () => {
    const onToolRequest = vi.fn(async () => ({ behavior: 'deny' as const, message: 'blocked' }))
    const fake = makeFake()
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    const session = driver.createSession(makeCtx({ onToolRequest }))
    await tick()

    const handler = fake.getPermissionHandler()
    const decision = await handler({
      sessionId: 'sess-1',
      toolCall: { toolCallId: 't2', kind: 'edit', rawInput: { path: '/tmp/f.txt' } },
      options: ALLOW_REJECT_OPTIONS
    })

    expect(onToolRequest).toHaveBeenCalledWith(
      'write',
      { file_path: '/tmp/f.txt' },
      expect.any(Object)
    )
    expect(decision).toEqual({ optionId: 'reject-once' })
    session.end()
  })

  it('bypassPermissions auto-allows WITHOUT calling onToolRequest', async () => {
    const onToolRequest = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }))
    const fake = makeFake()
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    const session = driver.createSession(
      makeCtx({ onToolRequest, permissionMode: 'bypassPermissions' })
    )
    await tick()

    const handler = fake.getPermissionHandler()
    const decision = await handler({
      sessionId: 'sess-1',
      toolCall: { toolCallId: 't3', kind: 'execute', rawInput: { command: 'rm -rf /' } },
      options: ALLOW_REJECT_OPTIONS
    })

    expect(onToolRequest).not.toHaveBeenCalled()
    expect(decision).toEqual({ optionId: 'allow-once' })
    session.end()
  })

  it('acceptEdits mode runs classifyOnly (no card) and honors a deny verdict for edit/delete/move kinds', async () => {
    const onToolRequest = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }))
    const classifyOnly = vi.fn(() => ({ action: 'deny' as const, reason: 'outside sandbox' }))
    const fake = makeFake()
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    const session = driver.createSession(
      makeCtx({ onToolRequest, classifyOnly, permissionMode: 'acceptEdits' })
    )
    await tick()

    const handler = fake.getPermissionHandler()
    const decision = await handler({
      sessionId: 'sess-1',
      toolCall: { toolCallId: 't4', kind: 'delete', rawInput: { path: '/etc/passwd' } },
      options: ALLOW_REJECT_OPTIONS
    })

    expect(onToolRequest).not.toHaveBeenCalled()
    expect(classifyOnly).toHaveBeenCalledWith('write', { file_path: '/etc/passwd' })
    expect(decision).toEqual({ optionId: 'reject-once' })
    session.end()
  })
})

describe('createAcpDriver — session lifecycle + event normalization', () => {
  it('reports the ACP sessionId as the cursor, yields normalized events from a scripted update stream, and fires onTurnResult before the turn boundary', async () => {
    const onCursor = vi.fn()
    const onTurnResult = vi.fn<(r: TurnResult) => void>()
    const fake = makeFake('cursor-session-abc')
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    const session = driver.createSession(makeCtx({ onCursor, onTurnResult }))
    await tick()
    expect(onCursor).toHaveBeenCalledWith('cursor-session-abc')

    const seen: AgentEvent[] = []
    const drained = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()

    session.send('do the thing')
    await tick()
    expect(fake.calls).toContain('prompt:do the thing')

    const update = fake.getUpdateCb()
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } })
    update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read' })
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [],
      rawOutput: 'file contents'
    })
    fake.resolvePrompt() // signals turn end (client.ts discards the real stopReason)
    await tick()

    session.end()
    await drained

    expect(seen.map((e) => e.type)).toEqual([
      'content.delta',
      'tool.call.started',
      'tool.call.completed',
      'turn.completed'
    ])
    expect((seen[0].payload as { text: string }).text).toBe('hello')
    expect(onTurnResult).toHaveBeenCalledTimes(1)
    expect(onTurnResult.mock.calls[0][0].authFailure).toBe(false)
    const turnCompleted = seen[seen.length - 1] as Extract<AgentEvent, { type: 'turn.completed' }>
    expect(turnCompleted.payload.status).toBe('success')
    expect(fake.stop).toHaveBeenCalledTimes(1) // no orphaned runtime
  })

  it('an interrupted turn yields turn.completed with status "interrupted"', async () => {
    const fake = makeFake()
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    const session = driver.createSession(makeCtx())
    await tick()

    const seen: AgentEvent[] = []
    const drained = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()

    session.send('do the thing')
    await tick()
    await session.interrupt()
    fake.resolvePrompt() // ACP signals turn end via the prompt promise settling, even on cancel
    await tick()

    session.end()
    await drained

    const turnCompleted = seen.find((e) => e.type === 'turn.completed') as
      Extract<AgentEvent, { type: 'turn.completed' }> | undefined
    expect(turnCompleted?.payload.status).toBe('interrupted')
  })

  it('a pending approval interrupted mid-turn resolves to cancelled', async () => {
    const fake = makeFake()
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    // Mirrors the real harness pipeline's contract: onToolRequest rejects when its signal
    // aborts (rather than hanging forever), which is what lets the driver's onPermission
    // catch block map the rejection to `{ cancelled: true }`.
    const onToolRequest = (
      _name: string,
      _input: Record<string, unknown>,
      opts: { signal: AbortSignal }
    ): Promise<never> =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const session = driver.createSession(makeCtx({ onToolRequest }))
    await tick()

    session.send('do the thing')
    await tick()

    const handler = fake.getPermissionHandler()
    const decisionPromise = handler({
      sessionId: 'sess-1',
      toolCall: { toolCallId: 't1', kind: 'execute', rawInput: { command: 'ls' } },
      options: ALLOW_REJECT_OPTIONS
    })

    await session.interrupt()
    await expect(decisionPromise).resolves.toEqual({ cancelled: true })
    session.end()
  })

  it('after interrupting turn 1, a turn-2 permission request still calls onToolRequest and maps the decision', async () => {
    const onToolRequest = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }))
    const fake = makeFake()
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    const session = driver.createSession(makeCtx({ onToolRequest }))
    await tick()

    // Turn 1: interrupt it.
    session.send('turn one')
    await tick()
    await session.interrupt()
    fake.resolvePrompt()
    await tick()

    // Turn 2: a fresh prompt dispatch must reset the per-turn abort scope.
    session.send('turn two')
    await tick()

    const handler = fake.getPermissionHandler()
    const decision = await handler({
      sessionId: 'sess-1',
      toolCall: { toolCallId: 't2', kind: 'execute', rawInput: { command: 'ls -la' } },
      options: ALLOW_REJECT_OPTIONS
    })

    expect(onToolRequest).toHaveBeenCalledTimes(1)
    expect(onToolRequest).toHaveBeenCalledWith('shell', { command: 'ls -la' }, expect.any(Object))
    expect(decision).toEqual({ optionId: 'allow-once' })
    session.end()
  })

  it('loadSession is used when ctx.resumeCursor is set', async () => {
    const fake = makeFake()
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    const session = driver.createSession(makeCtx({ resumeCursor: 'prior-session-id' }))
    await tick()
    expect(fake.calls.some((c) => c.startsWith('loadSession:prior-session-id'))).toBe(true)
    session.end()
  })

  it('a non-auth prompt rejection is fatal and stops the client', async () => {
    const fake = makeFake()
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    const session = driver.createSession(makeCtx())
    await tick()
    session.send('go')
    await tick()

    const drain = (async () => {
      for await (const e of session.events()) void e
    })()
    fake.rejectPrompt(new Error('scripted fatal failure'))
    await expect(drain).rejects.toThrow('scripted fatal failure')
    await tick()
    expect(fake.stop).toHaveBeenCalledTimes(1)
  })

  it('an auth-shaped prompt rejection surfaces via onTurnResult(authFailure) without killing the stream', async () => {
    const onTurnResult = vi.fn<(r: TurnResult) => void>()
    const fake = makeFake()
    const driver = createAcpDriver(PROFILE, { clientFactory: fake.factory })
    const session = driver.createSession(makeCtx({ onTurnResult }))
    await tick()
    session.send('go')
    await tick()

    const seen: AgentEvent[] = []
    const drained = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()
    fake.rejectPrompt(new Error('Unauthorized: invalid API key'))
    await tick()
    session.end()
    await drained

    expect(onTurnResult).toHaveBeenCalledTimes(1)
    expect(onTurnResult.mock.calls[0][0].authFailure).toBe(true)
  })
})

// probeAuth coverage (env-var precondition + bounded live handshake + timeout + teardown +
// error classification) lives in `__tests__/probe.test.ts` (Task 10), which injects a scripted
// `clientFactory` per case. A driver-level `probeAuth({})` call with the DEFAULT clientFactory
// (as this suite's `PROFILE`/`createAcpDriver(PROFILE)` would exercise) now performs a real
// bounded spawn of `cursor-agent`, which doesn't exist in this environment — out of scope here.
