import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../../../db'
import { createDetection } from '../../../../packs/detection'
import { createClaudeDriver, type CreateQueryFn } from '../index'
import { clearCatalogCache } from '../catalog'
import type { NativeToolDeps } from '../../../nativeTools'
import type { DatabaseSync } from 'node:sqlite'

let tmp: string, argusHome: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-driver-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  // The catalog cache is module-scoped (keyed by resolved cliPath, '<default>' in these
  // tests), so it would otherwise leak a resolved promise across tests in this file.
  clearCatalogCache()
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

// The driver only *constructs* the argus MCP server from these deps; its tools are
// never invoked in these tests, so a minimal deps bag (no panel/openPanel wiring) is
// enough — mirrors the shape the nativeTools tests build.
function minimalNativeDeps(): NativeToolDeps {
  return {
    db,
    argusHome,
    detection: createDetection(),
    caseId: 1,
    caseSlug: 'c',
    sessionId: 1,
    emitFinding: () => {}
  }
}

/** The options bag from the most recent createQuery call — how the SDK was actually configured. */
let lastOptions: Record<string, unknown> | null = null

/**
 * The real session's createQuery call, picked out of a spy's recorded calls by
 * filtering rather than indexing positionally (same technique as registry.test.ts's
 * fakeCreateQuery). `baseCtx()` omits `model` today, so `catalogFor` short-circuits and
 * `calls[0]` happens to be the real call — but that is an accident of the current
 * fixture, not a contract. If a future `baseCtx()` pins a model, a catalog-probe call
 * (recognizable because it never sets `systemPrompt` — see catalog.ts's ask()) would
 * land first, and `calls[0]` would silently become the wrong call.
 */
function sessionCallOptions(spy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const call = spy.mock.calls.find(
    (c) => (c[0] as { options: Record<string, unknown> }).options.systemPrompt
  )
  return (call?.[0] as { options: Record<string, unknown> }).options
}

function fakeQuery(messages: unknown[]): CreateQueryFn {
  return (args) => {
    lastOptions = args.options
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m
      },
      interrupt: async () => undefined
    }
  }
}

const baseCtx = (): Parameters<ReturnType<typeof createClaudeDriver>['createSession']>[0] => ({
  caseDir: tmp,
  additionalDirectories: [],
  skills: [],
  subagents: [],
  permissionMode: 'default' as const,
  systemAppend: 'PERSONA',
  extraMcpServers: {},
  nativeToolDeps: minimalNativeDeps(),
  panelCommandDecls: [],
  resumeCursor: null,
  eventCtx: () => ({ caseId: 1, caseSlug: 'c', sessionId: 1, turnId: 7 }),
  onToolRequest: async () => ({ behavior: 'allow' as const, updatedInput: {} }),
  onCursor: vi.fn(),
  onTurnResult: vi.fn()
})

describe('createClaudeDriver', () => {
  it('advertises its kind, taxonomy, and capabilities', () => {
    const driver = createClaudeDriver(fakeQuery([]))
    expect(driver.kind).toBe('claude-agent-sdk')
    expect(driver.toolTaxonomy).toBeTruthy()
    expect(driver.capabilities).toMatchObject({
      editableApprovals: true,
      costReporting: true
    })
    expect(driver.capabilities.permissionModes).toContain('default')
  })

  it('forwards ctx.systemAppend as the preset system-prompt append', async () => {
    // The fixture supplied systemAppend for a long time without anything asserting it landed —
    // exactly the blind spot that let the ACP driver drop it unnoticed.
    const session = createClaudeDriver(fakeQuery([])).createSession(baseCtx())
    // The SDK query() is now constructed behind a catalog lookup (see index.ts's
    // handleReady); draining events() awaits that resolution so lastOptions is set.
    for await (const _ of session.events()) void _
    expect(lastOptions?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'PERSONA'
    })
  })

  it("disables Claude Code's own auto-memory so memories route to write_memory", async () => {
    // The claude_code preset ships its own auto-memory subsystem, which defaults ON and tells
    // the model to store memories as files under ~/.claude/projects/<sanitized-cwd>/memory/ via
    // the Write tool. That competed with Argus's write_memory tool and won — observed writing to
    // ~/.claude/projects/-Users-…-Argus-cases-NN-5187/memory/. The env var is the right lever:
    // it sits ABOVE settings.json in the CLI's precedence chain, and Argus passes
    // settingSources:['project'], so a user-level autoMemoryEnabled:false would not be read.
    const session = createClaudeDriver(fakeQuery([])).createSession(baseCtx())
    for await (const _ of session.events()) void _
    const env = lastOptions?.env as Record<string, string | undefined> | undefined
    expect(env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
  })

  it('inherits process.env when disabling auto-memory', async () => {
    // SDK contract (sdk.d.ts): `env` REPLACES the subprocess environment entirely rather than
    // merging with process.env. Setting it without spreading would strip PATH/HOME/auth and
    // break every session — a far worse bug than the one being fixed.
    process.env.ARGUS_ENV_INHERIT_PROBE = 'inherited'
    try {
      const session = createClaudeDriver(fakeQuery([])).createSession(baseCtx())
      for await (const _ of session.events()) void _
      const env = lastOptions?.env as Record<string, string | undefined> | undefined
      expect(env?.ARGUS_ENV_INHERIT_PROBE).toBe('inherited')
    } finally {
      delete process.env.ARGUS_ENV_INHERIT_PROBE
    }
  })

  it('normalizes the SDK stream into AgentEvents and reports cursor + turn result', async () => {
    const ctx = baseCtx()
    const driver = createClaudeDriver(
      fakeQuery([
        {
          type: 'system',
          subtype: 'init',
          session_id: '11111111-1111-4111-8111-111111111111',
          model: 'claude-sonnet-5'
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0.01,
          duration_ms: 900,
          session_id: '11111111-1111-4111-8111-111111111111'
        }
      ])
    )
    const session = driver.createSession(ctx)
    const events: string[] = []
    for await (const e of session.events()) events.push(e.type)
    expect(ctx.onCursor).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111')
    expect(ctx.onTurnResult).toHaveBeenCalledWith(
      expect.objectContaining({
        isError: false,
        inputTokens: 10,
        costUsd: 0.01,
        authFailure: false
      })
    )
    expect(events).toContain('session.started')
    expect(events).toContain('turn.completed')
  })

  it('rejects a non-UUID resume cursor (Claude cursor validation lives in the driver)', async () => {
    const spy = vi.fn(fakeQuery([]))
    const session = createClaudeDriver(spy).createSession({
      ...baseCtx(),
      resumeCursor: 'copilot-abc'
    })
    for await (const _ of session.events()) void _
    expect(sessionCallOptions(spy).resume).toBeUndefined()
  })

  it('passes a UUID resume cursor through as the resume option', async () => {
    const spy = vi.fn(fakeQuery([]))
    const session = createClaudeDriver(spy).createSession({
      ...baseCtx(),
      resumeCursor: '11111111-1111-4111-8111-111111111111'
    })
    for await (const _ of session.events()) void _
    expect(sessionCallOptions(spy).resume).toBe('11111111-1111-4111-8111-111111111111')
  })

  // `session.started.resumed` drives observability: the Langfuse exporter opens a new
  // trace root for a fresh session and only a lightweight marker for a resumed one.
  // The flag must mirror the SAME condition that decides whether `resume` is actually
  // passed to the SDK — an invalid cursor means the SDK starts fresh, so reporting a
  // resume there would be a lie.
  async function resumedFlagFor(resumeCursor: string | null): Promise<boolean | undefined> {
    const session = createClaudeDriver(
      fakeQuery([
        {
          type: 'system',
          subtype: 'init',
          session_id: '11111111-1111-4111-8111-111111111111',
          model: 'claude-sonnet-5'
        }
      ])
    ).createSession({ ...baseCtx(), resumeCursor })
    for await (const e of session.events()) {
      if (e.type === 'session.started') return e.payload.resumed
    }
    return undefined
  }

  it('reports resumed=true when a UUID cursor actually resumes the SDK session', async () => {
    expect(await resumedFlagFor('11111111-1111-4111-8111-111111111111')).toBe(true)
  })

  it('reports resumed=false with no cursor', async () => {
    expect(await resumedFlagFor(null)).toBe(false)
  })

  it('reports resumed=false for a non-UUID cursor, which the SDK never receives', async () => {
    expect(await resumedFlagFor('copilot-abc')).toBe(false)
  })

  // GUARD — do not delete without reading this.
  // Top-level tool calls get their `tool.call.started` (and therefore their name and
  // duration) ONLY from `stream_event` partials, which exist only while
  // includePartialMessages is on. normalize.ts deliberately does NOT recover them from
  // finished assistant messages, because top-level tool_use arrives on BOTH paths with
  // the same id and the duplicate would clobber the real start time.
  // Turning this option off would silently strip names and durations from every
  // top-level tool in Langfuse, with nothing pointing back to the cause. This test is
  // that pointer.
  it('keeps includePartialMessages on — top-level tool starts depend on it', async () => {
    const spy = vi.fn(fakeQuery([]))
    const session = createClaudeDriver(spy).createSession(baseCtx())
    for await (const _ of session.events()) void _
    expect(sessionCallOptions(spy).includePartialMessages).toBe(true)
  })

  it('omits the agents key when no subagents are configured', async () => {
    const spy = vi.fn(fakeQuery([]))
    const session = createClaudeDriver(spy).createSession(baseCtx())
    for await (const _ of session.events()) void _
    const options = sessionCallOptions(spy)
    expect('agents' in options).toBe(false)
    expect(options.agents).toBeUndefined()
  })

  it('includes agents in options when subagents are configured', async () => {
    const spy = vi.fn(fakeQuery([]))
    const ctx = {
      ...baseCtx(),
      subagents: [
        {
          name: 'review-security',
          description: 'when auth changes',
          prompt: 'SECURITY_REVIEW_PROMPT',
          tools: ['read', 'search'] as const
        },
        {
          name: 'test-analyzer',
          description: 'for test failures',
          prompt: 'TEST_PROMPT',
          tools: ['execute'] as const
        }
      ]
    }
    const session = createClaudeDriver(spy).createSession(ctx)
    for await (const _ of session.events()) void _
    const options = sessionCallOptions(spy)
    expect(options.agents).toEqual({
      'review-security': {
        description: 'when auth changes',
        prompt: 'SECURITY_REVIEW_PROMPT',
        tools: ['Read', 'Grep', 'Glob']
      },
      'test-analyzer': {
        description: 'for test failures',
        prompt: 'TEST_PROMPT',
        tools: ['Bash']
      }
    })
  })

  it('flags auth-shaped failed turns', async () => {
    const ctx = baseCtx()
    const driver = createClaudeDriver(
      fakeQuery([
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'Not logged in · Please run /login',
          api_error_status: null
        }
      ])
    )
    for await (const _ of driver.createSession(ctx).events()) void _
    expect(ctx.onTurnResult).toHaveBeenCalledWith(expect.objectContaining({ authFailure: true }))
  })

  it('backfills tool.call.completed names from the in-flight tool map', async () => {
    const ctx = baseCtx()
    const driver = createClaudeDriver(
      fakeQuery([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tc-1', name: 'Bash' }
          }
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'ok', is_error: false }]
          }
        }
      ])
    )
    const completed: Array<{ type: string; payload: { name?: string } }> = []
    for await (const e of driver.createSession(ctx).events()) {
      if (e.type === 'tool.call.completed') completed.push(e as never)
    }
    expect(completed[0].payload.name).toBe('Bash')
  })

  it('propagates errors thrown by the underlying query stream out of events()', async () => {
    const driver = createClaudeDriver(() => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new Error('stream exploded')
      },
      interrupt: async () => undefined
    }))
    await expect(async () => {
      for await (const _ of driver.createSession(baseCtx()).events()) void _
    }).rejects.toThrow(/stream exploded/)
  })

  it('send() enqueues an SDK user envelope on the prompt stream', async () => {
    let captured: AsyncIterable<unknown> | undefined
    const spy: CreateQueryFn = (args) => {
      captured = args.prompt
      return fakeQuery([])(args)
    }
    const session = createClaudeDriver(spy).createSession(baseCtx())
    session.send('analyze the crash')
    // The prompt queue exists immediately (send() above is unaffected), but `captured`
    // is only set once the deferred query() call actually happens — wait for that.
    for await (const _ of session.events()) void _
    const first = (await captured![Symbol.asyncIterator]().next()).value as {
      type: string
      message: { content: [{ text: string }] }
    }
    expect(first.type).toBe('user')
    expect(first.message.content[0].text).toBe('analyze the crash')
  })

  // Finding 3: end()/stop() used to only close the prompt queue, then interrupt()
  // awaited handleReady — constructing the real query() FIRST and only then
  // interrupting it. A session cancelled during the cold-cache window (the catalog
  // fetch is in flight) therefore still guaranteed a real CLI spawn, MCP servers
  // included, for a session the user already stopped.
  it('never constructs the real query when the session is ended before the catalog resolves', async () => {
    let releaseCatalog: (models: unknown[]) => void = () => {}
    const catalogGate = new Promise<unknown[]>((resolve) => {
      releaseCatalog = resolve
    })
    const probeCalls: Record<string, unknown>[] = []
    const spy: CreateQueryFn = vi.fn((args) => {
      const options = args.options as Record<string, unknown>
      if (!options.systemPrompt) {
        // The catalog probe (catalog.ts's ask()) — never sets systemPrompt.
        probeCalls.push(options)
        return {
          supportedModels: () => catalogGate,
          interrupt: async () => undefined,
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          [Symbol.asyncIterator]: async function* () {}
        } as unknown as ReturnType<CreateQueryFn>
      }
      // The real session query — must never be reached in this test.
      return fakeQuery([])(args)
    })

    const session = createClaudeDriver(spy).createSession({ ...baseCtx(), model: 'claude-opus-5' })

    // Stop the session while the catalog fetch is still in flight.
    session.end()
    await Promise.resolve() // let the probe call actually land before we release it

    expect(probeCalls.length).toBe(1) // the catalog fetch did start...

    releaseCatalog([]) // ...but only resolves after cancellation

    // Draining events() (and interrupt()) must both settle without ever calling
    // createQuery a second time for the real session.
    for await (const _ of session.events()) void _
    await session.interrupt()

    const realSessionCalls = (spy as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0].options as Record<string, unknown>).systemPrompt
    )
    expect(realSessionCalls.length).toBe(0)
  })
})
