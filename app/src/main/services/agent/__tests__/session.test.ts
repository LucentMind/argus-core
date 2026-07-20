import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { CaseSession } from '../session'
import { createClaudeDriver, isAuthFailure, type CreateQueryFn } from '../drivers/claude'
import { createSession } from '../sessionStore'
import { AsyncQueue } from '../asyncQueue'
import { applyMemoryWrite } from '../../memory'
import { createDetection } from '../../packs/detection'
import { agentAccessSchema } from '../../../../shared/agentAccess'
import { CLAUDE_TOOL_TAXONOMY } from '../risk'
import type { AgentDriver } from '../driver'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { DatabaseSync } from 'node:sqlite'

interface FakeSdk {
  messages: AsyncQueue<unknown>
  captured: { prompt?: AsyncIterable<unknown>; options?: Record<string, unknown> }
  createQuery: CreateQueryFn
  interrupt: () => Promise<void>
}

function fakeSdk(): FakeSdk {
  const messages = new AsyncQueue<unknown>()
  const captured: { prompt?: AsyncIterable<unknown>; options?: Record<string, unknown> } = {}
  const interrupt = vi.fn(async () => messages.end())
  const createQuery: CreateQueryFn = (args) => {
    captured.prompt = args.prompt
    captured.options = args.options
    return Object.assign(
      { [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator]() },
      { interrupt }
    )
  }
  return { messages, captured, createQuery, interrupt }
}

let tmp: string, argusHome: string, db: DatabaseSync
let events: AgentEvent[]

function makeSession(
  sdk: ReturnType<typeof fakeSdk>,
  overrides: Partial<ConstructorParameters<typeof CaseSession>[0]> = {}
): CaseSession {
  // Reuse the case row if a prior call in this test already created it — lets tests
  // create extra session rows for 'NAV-1' via sessionStore before calling makeSession.
  const rec = getCase(db, 'NAV-1') ?? createCase(db, argusHome, { slug: 'NAV-1', title: 't' })
  const sessionId = createSession(db, 'NAV-1', 'claude-agent-sdk').id
  return new CaseSession({
    db,
    argusHome,
    detection: createDetection(),
    caseId: rec.id,
    caseSlug: 'NAV-1',
    sessionId,
    workspaceRoots: [],
    skillsRoots: [],
    emit: (e) => events.push(e),
    driver: createClaudeDriver(sdk.createQuery),
    resumeCursor: null,
    ...overrides
  })
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sess-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  events = []
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('CaseSession', () => {
  it('send() enqueues an SDK user message and emits turn.started', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    s.send('analyze the crash')
    await flush()
    expect(events.some((e) => e.type === 'turn.started')).toBe(true)
    const iter = sdk.captured.prompt![Symbol.asyncIterator]()
    const first = (await iter.next()).value as {
      type: string
      message: { content: [{ text: string }] }
    }
    expect(first.type).toBe('user')
    expect(first.message.content[0].text).toBe('analyze the crash')
    const turn = db.prepare(`SELECT * FROM turns`).get()
    expect(turn).toBeTruthy()
    await s.stop('stopped')
  })

  // chat search resolves hits via messages_fts.turn_id — pin that indexText
  // attributes each user/assistant text to the turns-table row it belongs to
  // across multiple turns (a stale/reset currentTurnRow would break jumps)
  it('indexes user and assistant text under the turn each belongs to', async () => {
    const sdk = fakeSdk()
    const indexed: Array<{ role: string; content: string; turnId: number | null }> = []
    const s = makeSession(sdk, {
      mirror: {
        append: () => {},
        indexText: (role, content, turnId) => indexed.push({ role, content, turnId })
      }
    })
    s.send('first question')
    sdk.messages.push({
      type: 'assistant',
      session_id: 'x',
      message: { content: [{ type: 'text', text: 'first answer' }] }
    })
    await flush()
    s.send('second question')
    sdk.messages.push({
      type: 'assistant',
      session_id: 'x',
      message: { content: [{ type: 'text', text: 'second answer' }] }
    })
    await flush()
    const turns = db.prepare(`SELECT id FROM turns ORDER BY id`).all() as { id: number }[]
    expect(turns).toHaveLength(2)
    expect(indexed).toEqual([
      { role: 'user', content: 'first question', turnId: turns[0].id },
      { role: 'assistant', content: 'first answer', turnId: turns[0].id },
      { role: 'user', content: 'second question', turnId: turns[1].id },
      { role: 'assistant', content: 'second answer', turnId: turns[1].id }
    ])
    await s.stop('stopped')
  })

  it('normalizes streamed messages and persists the resume cursor + turn usage', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    s.send('go')
    sdk.messages.push({
      type: 'system',
      subtype: 'init',
      session_id: '11111111-1111-4111-8111-111111111111',
      model: 'm'
    })
    sdk.messages.push({
      type: 'stream_event',
      session_id: 'x',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }
    })
    sdk.messages.push({
      type: 'result',
      subtype: 'success',
      session_id: '11111111-1111-4111-8111-111111111111',
      usage: { input_tokens: 5, output_tokens: 2 },
      total_cost_usd: 0.001,
      duration_ms: 10,
      is_error: false
    })
    await flush()
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['session.started', 'content.delta', 'turn.completed'])
    )
    const sess = db.prepare(`SELECT driver_cursor, turn_count FROM sessions`).get() as {
      driver_cursor: string
      turn_count: number
    }
    expect(sess.driver_cursor).toBe('11111111-1111-4111-8111-111111111111')
    expect(sess.turn_count).toBe(1)
    const turn = db.prepare(`SELECT status, input_tokens FROM turns`).get() as {
      status: string
      input_tokens: number
    }
    expect(turn.status).toBe('success')
    expect(turn.input_tokens).toBe(5)
    await s.stop('stopped')
  })

  it('records the init model on the completed turn', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    s.send('go')
    sdk.messages.push({
      type: 'system',
      subtype: 'init',
      session_id: '11111111-1111-4111-8111-111111111111',
      model: 'claude-opus-4-8'
    })
    sdk.messages.push({
      type: 'result',
      subtype: 'success',
      session_id: '11111111-1111-4111-8111-111111111111',
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01,
      duration_ms: 100,
      is_error: false
    })
    await flush()
    const row = db.prepare(`SELECT model FROM turns ORDER BY id DESC LIMIT 1`).get() as {
      model: string | null
    }
    expect(row.model).toBe('claude-opus-4-8')
    await s.stop('stopped')
  })

  it('records the model from result.modelUsage when it differs from the init model', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    s.send('go')
    sdk.messages.push({
      type: 'system',
      subtype: 'init',
      session_id: '11111111-1111-4111-8111-111111111111',
      model: 'claude-opus-4-8'
    })
    sdk.messages.push({
      type: 'result',
      subtype: 'success',
      session_id: '11111111-1111-4111-8111-111111111111',
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01,
      duration_ms: 100,
      is_error: false,
      modelUsage: {
        'claude-sonnet-5': {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.01,
          contextWindow: 200000,
          maxOutputTokens: 8192
        }
      }
    })
    await flush()
    const row = db.prepare(`SELECT model FROM turns ORDER BY id DESC LIMIT 1`).get() as {
      model: string | null
    }
    expect(row.model).toBe('claude-sonnet-5')
    await s.stop('stopped')
  })

  it('updates currentModel on model_refusal_fallback so a later result without modelUsage records the fallback model', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    s.send('go')
    sdk.messages.push({
      type: 'system',
      subtype: 'init',
      session_id: '11111111-1111-4111-8111-111111111111',
      model: 'claude-opus-4-8'
    })
    sdk.messages.push({
      type: 'system',
      subtype: 'model_refusal_fallback',
      trigger: 'refusal',
      direction: 'retry',
      original_model: 'claude-opus-4-8',
      fallback_model: 'claude-sonnet-5',
      request_id: null,
      content: '',
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      session_id: '11111111-1111-4111-8111-111111111111'
    })
    sdk.messages.push({
      type: 'result',
      subtype: 'success',
      session_id: '11111111-1111-4111-8111-111111111111',
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01,
      duration_ms: 100,
      is_error: false
    })
    await flush()
    const row = db.prepare(`SELECT model FROM turns ORDER BY id DESC LIMIT 1`).get() as {
      model: string | null
    }
    expect(row.model).toBe('claude-sonnet-5')
    await s.stop('stopped')
  })

  it('ignores transient session ids from non-durable system messages', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    s.send('go')
    sdk.messages.push({
      type: 'system',
      subtype: 'init',
      session_id: '11111111-1111-4111-8111-111111111111',
      model: 'm'
    })
    sdk.messages.push({ type: 'system', subtype: 'hook_event', session_id: 'transient-not-a-uuid' })
    await flush()
    const sess = db.prepare(`SELECT driver_cursor FROM sessions`).get() as {
      driver_cursor: string
    }
    expect(sess.driver_cursor).toBe('11111111-1111-4111-8111-111111111111')
    await s.stop('stopped')
  })

  it('canUseTool: LOW auto-allows and logs; HIGH round-trips an approval', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    s.send('go')
    await flush()
    const canUseTool = sdk.captured.options!.canUseTool as (
      n: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string; message?: string }>

    const low = await canUseTool(
      'Bash',
      { command: 'git log' },
      { signal: new AbortController().signal }
    )
    expect(low.behavior).toBe('allow')

    const highP = canUseTool(
      'Bash',
      { command: 'git push' },
      { signal: new AbortController().signal }
    )
    await flush()
    const opened = events.find((e) => e.type === 'request.opened')!
    expect(opened.payload).toMatchObject({ tool: 'Bash', risk: 'HIGH' })
    expect(
      s.respond({
        requestId: (opened.payload as { requestId: string }).requestId,
        kind: 'deny',
        comment: 'no'
      })
    ).toBe(true)
    const high = await highP
    expect(high.behavior).toBe('deny')
    expect(high.message).toBe('no')

    const rows = db.prepare(`SELECT tool, risk, decision FROM tool_calls ORDER BY id`).all() as {
      tool: string
      risk: string
      decision: string
    }[]
    expect(rows).toEqual([
      expect.objectContaining({ tool: 'Bash', risk: 'LOW', decision: 'auto' }),
      expect.objectContaining({ tool: 'Bash', risk: 'HIGH', decision: 'denied' })
    ])
    await s.stop('stopped')
  })

  it('allow-session creates a grant that short-circuits the next ask', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    s.send('go')
    await flush()
    const canUseTool = sdk.captured.options!.canUseTool as (
      n: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string }>

    const p1 = canUseTool(
      'Bash',
      { command: 'git fetch origin' },
      { signal: new AbortController().signal }
    )
    await flush()
    const opened = events.find((e) => e.type === 'request.opened')!
    s.respond({
      requestId: (opened.payload as { requestId: string }).requestId,
      kind: 'allow-session'
    })
    expect((await p1).behavior).toBe('allow')

    const p2 = await canUseTool(
      'Bash',
      { command: 'git fetch origin' },
      { signal: new AbortController().signal }
    )
    expect(p2.behavior).toBe('allow')
    const last = db.prepare(`SELECT decision FROM tool_calls ORDER BY id DESC LIMIT 1`).get() as {
      decision: string
    }
    expect(last.decision).toBe('grant')
    await s.stop('stopped')
  })

  it('stop() drains pending approvals with request.resolved cancelled', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    s.send('go')
    await flush()
    const canUseTool = sdk.captured.options!.canUseTool as (
      n: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string }>
    const pending = canUseTool(
      'Bash',
      { command: 'git push' },
      { signal: new AbortController().signal }
    )
    await flush()
    await s.stop('stopped')
    expect((await pending).behavior).toBe('deny')
    expect(
      events.some(
        (e) =>
          e.type === 'request.resolved' &&
          (e.payload as { decision: string }).decision === 'cancelled'
      )
    ).toBe(true)
    expect(events.some((e) => e.type === 'session.exited')).toBe(true)
  })

  // Regression (Task 4 review): the pre-driver harness swallowed interrupt rejections
  // (`query.interrupt().catch(...)`), and stop() awaits interrupt() between draining
  // approvals and emitting session.exited / closing the mirror. A driver whose interrupt
  // rejects must therefore never abort the teardown or surface a rejection to IPC callers.
  it('stop() completes even when the driver session interrupt() rejects', async () => {
    const eventQueue = new AsyncQueue<AgentEvent>()
    const rejectingDriver: AgentDriver = {
      kind: 'claude-agent-sdk',
      toolTaxonomy: CLAUDE_TOOL_TAXONOMY,
      authFixHint: 'stub hint',
      capabilities: {
        permissionModes: ['default'],
        editableApprovals: true,
        costReporting: true,
        headlessOneShot: false
      },
      createSession: () => ({
        events: () => eventQueue,
        send: () => undefined,
        interrupt: async () => {
          throw new Error('interrupt transport failed')
        },
        end: () => eventQueue.end()
      }),
      probeAuth: async () => ({ ok: true, detail: '' })
    }
    const s = makeSession(fakeSdk(), { driver: rejectingDriver })
    await expect(s.stop('stopped')).resolves.toBeUndefined()
    expect(s.state).toBe('dead')
    expect(events.some((e) => e.type === 'session.exited')).toBe(true)
  })

  it('applies agentOptions: model, cliPath, permissionMode, personaAppend', async () => {
    const sdk = fakeSdk()
    const rec = createCase(db, argusHome, { slug: 'NAV-OPT', title: 't' })
    const s = new CaseSession({
      db,
      argusHome,
      detection: createDetection(),
      caseId: rec.id,
      caseSlug: 'NAV-OPT',
      sessionId: createSession(db, 'NAV-OPT', 'claude-agent-sdk').id,
      workspaceRoots: [],
      skillsRoots: [],
      emit: (e) => events.push(e),
      driver: createClaudeDriver(sdk.createQuery),
      resumeCursor: null,
      agentOptions: {
        model: 'claude-sonnet-5',
        cliPath: 'C:\\tools\\claude.exe',
        permissionMode: 'plan',
        personaAppend: 'Focus on ADAS module defects.'
      }
    })
    const o = sdk.captured.options!
    expect(o.model).toBe('claude-sonnet-5')
    expect(o.pathToClaudeCodeExecutable).toBe('C:\\tools\\claude.exe')
    expect(o.permissionMode).toBe('plan')
    const sp = o.systemPrompt as { append: string }
    expect(sp.append).toContain('Focus on ADAS module defects.')
    expect(sp.append.indexOf('You are Argus')).toBeLessThan(sp.append.indexOf('Focus on ADAS'))
    await s.stop('stopped')
  })

  it('omits model/permissionMode/cliPath when agentOptions is absent or default', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk) // no agentOptions
    const o = sdk.captured.options!
    expect(o.model).toBeUndefined()
    expect(o.permissionMode).toBeUndefined()
    expect(o.pathToClaudeCodeExecutable).toBeUndefined()
    await s.stop('stopped')

    const sdk2 = fakeSdk()
    const rec2 = createCase(db, argusHome, { slug: 'NAV-DEF', title: 't' })
    const s2 = new CaseSession({
      db,
      argusHome,
      detection: createDetection(),
      caseId: rec2.id,
      caseSlug: 'NAV-DEF',
      sessionId: createSession(db, 'NAV-DEF', 'claude-agent-sdk').id,
      workspaceRoots: [],
      skillsRoots: [],
      emit: (e) => events.push(e),
      driver: createClaudeDriver(sdk2.createQuery),
      resumeCursor: null,
      agentOptions: { permissionMode: 'default' }
    })
    expect(sdk2.captured.options!.permissionMode).toBeUndefined()
    await s2.stop('stopped')
  })

  it('canUseTool consults the live toolRisk getter per call', async () => {
    const sdk = fakeSdk()
    const overrides: Record<string, 'low' | 'medium' | 'high'> = {}
    const s = makeSession(sdk, { toolRisk: () => overrides }) // extend makeSession to spread extra deps
    const canUseTool = sdk.captured.options!.canUseTool as (
      t: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string }>
    // frobnicate is unmatched → MEDIUM → would ask; override flips it live to LOW → auto-allow
    overrides['fix/frobnicate'] = 'low'
    const r = await canUseTool('mcp__fix__frobnicate', {}, { signal: new AbortController().signal })
    expect(r.behavior).toBe('allow')
    await s.stop('stopped')
  })

  it('merges extraMcpServers alongside the argus server and emits mcp-skipped events', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk, {
      extraMcpServers: { rovo: { type: 'sse', url: 'https://x', headers: {} } },
      mcpSkipped: [{ instanceId: 'dead', reason: 'spawn failed' }]
    })
    const servers = sdk.captured.options!.mcpServers as Record<string, unknown>
    expect(servers.rovo).toEqual({ type: 'sse', url: 'https://x', headers: {} })
    expect(servers.argus).toBeDefined() // the native server always wins the 'argus' key
    await flush() // skip emission is deferred past construction so a late-attached mirror sees it
    const skipEvents = events.filter((e) => e.type === 'session.mcp.skipped')
    expect(skipEvents).toHaveLength(1)
    expect(skipEvents[0].payload).toEqual({ instanceId: 'dead', reason: 'spawn failed' })
    await s.stop('stopped')
  })

  it('mcp-skipped events reach a mirror attached right after construction (registry pattern)', async () => {
    const sdk = fakeSdk()
    const appended: AgentEvent[] = []
    const s = makeSession(sdk, { mcpSkipped: [{ instanceId: 'dead', reason: 'spawn failed' }] })
    // AgentService.getOrCreate attaches the mirror synchronously right after the
    // constructor returns — the skip events must not have been emitted before this.
    ;(s as unknown as { deps: { mirror: unknown } }).deps.mirror = {
      append: (e: AgentEvent) => appended.push(e),
      indexText: () => {}
    }
    await flush()
    const skip = appended.filter((e) => e.type === 'session.mcp.skipped')
    expect(skip).toHaveLength(1)
    expect(skip[0].payload).toEqual({ instanceId: 'dead', reason: 'spawn failed' })
    await s.stop('stopped')
  })

  it('request.opened reaches an attached mirror without input; the live copy keeps it', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    const appended: AgentEvent[] = []
    ;(s as unknown as { deps: { mirror: unknown } }).deps.mirror = {
      append: (e: AgentEvent) => appended.push(e),
      indexText: () => {}
    }
    const canUseTool = sdk.captured.options!.canUseTool as (
      t: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string }>
    const pending = canUseTool(
      'mcp__rovo__addCommentToJiraIssue',
      { issueKey: 'NAV-7', body: 'draft RCA' },
      { signal: new AbortController().signal }
    )
    await vi.waitFor(() => expect(events.some((e) => e.type === 'request.opened')).toBe(true))
    const liveOpened = events.find((e) => e.type === 'request.opened')!
    expect((liveOpened.payload as { input?: unknown }).input).toEqual({
      issueKey: 'NAV-7',
      body: 'draft RCA'
    })
    const mirroredOpened = appended.find((e) => e.type === 'request.opened')!
    expect('input' in mirroredOpened.payload).toBe(false)
    s.respond({
      requestId: (liveOpened.payload as { requestId: string }).requestId,
      kind: 'deny'
    })
    await pending
    await s.stop('stopped')
  })

  it('does not emit mcp-skipped events when the session dies before the deferred emission', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk, { mcpSkipped: [{ instanceId: 'dead', reason: 'spawn failed' }] })
    await s.stop('stopped') // dies within the same synchronous block — before the microtask runs
    await flush()
    expect(events.filter((e) => e.type === 'session.mcp.skipped')).toHaveLength(0)
  })

  it('a LOW connector tool auto-approves and logs; a MEDIUM one asks (case-bound request event)', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    const canUseTool = sdk.captured.options!.canUseTool as (
      t: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string }>
    const low = await canUseTool(
      'mcp__rovo__getJiraIssue',
      { key: 'NAV-1' },
      { signal: new AbortController().signal }
    )
    expect(low.behavior).toBe('allow')
    const rows = db
      .prepare(`SELECT tool, risk, decision FROM tool_calls WHERE tool = ?`)
      .all('mcp__rovo__getJiraIssue')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ risk: 'LOW', decision: 'auto' })
    const ac = new AbortController()
    const pending = canUseTool(
      'mcp__rovo__addCommentToJiraIssue',
      { body: 'hi' },
      { signal: ac.signal }
    )
    await vi.waitFor(() => expect(events.some((e) => e.type === 'request.opened')).toBe(true))
    const req = events.find((e) => e.type === 'request.opened')!
    expect(req.payload).toMatchObject({ tool: 'mcp__rovo__addCommentToJiraIssue', risk: 'MEDIUM' })
    expect(req.caseSlug).toBeTruthy() // case-bound (spec §8)
    ac.abort() // cancel instead of answering — resolves the pending promise
    await pending
    await s.stop('stopped')
  })

  it('request.opened carries the full input; an edited approval flows back as updatedInput', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    const canUseTool = sdk.captured.options!.canUseTool as (
      t: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>

    const pending = canUseTool(
      'mcp__rovo__addCommentToJiraIssue',
      { issueKey: 'NAV-7', body: 'draft RCA' },
      { signal: new AbortController().signal }
    )
    await vi.waitFor(() => expect(events.some((e) => e.type === 'request.opened')).toBe(true))
    const opened = events.find((e) => e.type === 'request.opened')!
    expect((opened.payload as { input: unknown }).input).toEqual({
      issueKey: 'NAV-7',
      body: 'draft RCA'
    })
    s.respond({
      requestId: (opened.payload as { requestId: string }).requestId,
      kind: 'allow',
      updatedInput: { issueKey: 'NAV-7', body: 'edited RCA' }
    })
    const r = await pending
    expect(r.behavior).toBe('allow')
    expect(r.updatedInput).toEqual({ issueKey: 'NAV-7', body: 'edited RCA' })
    await s.stop('stopped')
  })

  it('ignores updatedInput on non-MCP asks — the original input is returned', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    const canUseTool = sdk.captured.options!.canUseTool as (
      t: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>

    const pending = canUseTool(
      'Bash',
      { command: 'git push' },
      { signal: new AbortController().signal }
    )
    await vi.waitFor(() => expect(events.some((e) => e.type === 'request.opened')).toBe(true))
    const opened = events.find((e) => e.type === 'request.opened')!
    s.respond({
      requestId: (opened.payload as { requestId: string }).requestId,
      kind: 'allow',
      updatedInput: { command: 'rm -rf /' } // spoofed edit — must not be honored
    })
    const r = await pending
    expect(r.behavior).toBe('allow')
    expect(r.updatedInput).toEqual({ command: 'git push' })
    await s.stop('stopped')
  })

  it('ignores updatedInput on Argus-native (mcp__argus__*) asks — the original input is returned', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    const canUseTool = sdk.captured.options!.canUseTool as (
      t: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>

    const pending = canUseTool(
      'mcp__argus__update_case_status',
      { status: 'analyzing' },
      { signal: new AbortController().signal }
    )
    await vi.waitFor(() => expect(events.some((e) => e.type === 'request.opened')).toBe(true))
    const opened = events.find((e) => e.type === 'request.opened')!
    s.respond({
      requestId: (opened.payload as { requestId: string }).requestId,
      kind: 'allow',
      updatedInput: { status: 'resolved' } // spoofed edit — must not be honored
    })
    const r = await pending
    expect(r.behavior).toBe('allow')
    expect(r.updatedInput).toEqual({ status: 'analyzing' })
    await s.stop('stopped')
  })

  it('allow-session with edits applies them to the current call; the grant then returns originals', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    const canUseTool = sdk.captured.options!.canUseTool as (
      t: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>

    const first = canUseTool(
      'mcp__rovo__addCommentToJiraIssue',
      { issueKey: 'NAV-7', body: 'draft RCA' },
      { signal: new AbortController().signal }
    )
    await vi.waitFor(() => expect(events.some((e) => e.type === 'request.opened')).toBe(true))
    const opened = events.find((e) => e.type === 'request.opened')!
    s.respond({
      requestId: (opened.payload as { requestId: string }).requestId,
      kind: 'allow-session',
      updatedInput: { issueKey: 'NAV-7', body: 'edited RCA' }
    })
    const r1 = await first
    expect(r1.behavior).toBe('allow')
    expect(r1.updatedInput).toEqual({ issueKey: 'NAV-7', body: 'edited RCA' })

    // identical ask short-circuits via the session grant — no new request, original input
    const before = events.filter((e) => e.type === 'request.opened').length
    const r2 = await canUseTool(
      'mcp__rovo__addCommentToJiraIssue',
      { issueKey: 'NAV-7', body: 'draft RCA' },
      { signal: new AbortController().signal }
    )
    expect(r2.behavior).toBe('allow')
    expect(r2.updatedInput).toEqual({ issueKey: 'NAV-7', body: 'draft RCA' })
    expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(before)
    await s.stop('stopped')
  })

  it('write_memory approval carries edited input back (allowlisted native tool)', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    const canUseTool = sdk.captured.options!.canUseTool as (
      t: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>

    const pending = canUseTool(
      'mcp__argus__write_memory',
      { topic: 't', content: 'draft', index_entry: 'e' },
      { signal: new AbortController().signal }
    )
    await vi.waitFor(() => expect(events.some((e) => e.type === 'request.opened')).toBe(true))
    const opened = events.find((e) => e.type === 'request.opened')!
    s.respond({
      requestId: (opened.payload as { requestId: string }).requestId,
      kind: 'allow',
      updatedInput: { topic: 't', content: 'EDITED', index_entry: 'e' }
    })
    const r = await pending
    expect(r.behavior).toBe('allow')
    expect(r.updatedInput).toEqual({ topic: 't', content: 'EDITED', index_entry: 'e' })
    await s.stop('stopped')
  })

  it('other native tools remain non-editable', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk)
    const canUseTool = sdk.captured.options!.canUseTool as (
      t: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>

    const pending = canUseTool(
      'mcp__argus__update_case_status',
      { status: 'analyzing' },
      { signal: new AbortController().signal }
    )
    await vi.waitFor(() => expect(events.some((e) => e.type === 'request.opened')).toBe(true))
    const opened = events.find((e) => e.type === 'request.opened')!
    s.respond({
      requestId: (opened.payload as { requestId: string }).requestId,
      kind: 'allow',
      updatedInput: { status: 'closed' }
    })
    const r = await pending
    expect(r.behavior).toBe('allow')
    expect(r.updatedInput).toEqual({ status: 'analyzing' })
    await s.stop('stopped')
  })

  it('injects the filtered memory index into the system prompt append', async () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'keep', content: 'k', indexEntry: 'kept lesson' })
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'drop',
      content: 'd',
      indexEntry: 'dropped lesson'
    })
    const access = agentAccessSchema.parse({ memory: { drop: false } })
    const sdk = fakeSdk()
    const s = makeSession(sdk, { agentAccess: () => access })
    const sys = sdk.captured.options!.systemPrompt as { append: string }
    expect(sys.append).toContain('## Agent memory')
    expect(sys.append).toContain('(keep.md)')
    expect(sys.append).not.toContain('(drop.md)')
    await s.stop('stopped')
  })

  it('memory files are not FS-readable — read_memory is the only read path', async () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'keep', content: 'k', indexEntry: 'kept' })
    const sdk = fakeSdk()
    const s = makeSession(sdk, { agentAccess: () => agentAccessSchema.parse({}) })
    const canUseTool = sdk.captured.options!.canUseTool as (
      t: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string }>
    const ac = new AbortController()
    // even ENABLED topic files deny at the FS layer; the read_memory tool is the sanctioned path
    const keepPath = path.join(argusHome, 'memory', 'keep.md')
    const indexPath = path.join(argusHome, 'memory', '_index.md')
    expect(
      (await canUseTool('Read', { file_path: keepPath }, { signal: ac.signal })).behavior
    ).not.toBe('allow')
    expect(
      (await canUseTool('Read', { file_path: indexPath }, { signal: ac.signal })).behavior
    ).not.toBe('allow')
    // the injected prompt points the agent at the tool, not the filesystem
    const sys = sdk.captured.options!.systemPrompt as { append: string }
    expect(sys.append).toContain('read_memory')
    await s.stop('stopped')
  })

  it('binds to the given session row and titles it from the first message', async () => {
    const sdk = fakeSdk()
    // create the case (via createCase) plus an extra row for it, then construct on the SECOND
    createCase(db, argusHome, { slug: 'NAV-1', title: 't' })
    const s2 = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const session = makeSession(sdk, { sessionId: s2.id })
    session.send('investigate braking failure on route 66')
    const title = (
      db.prepare(`SELECT title FROM sessions WHERE id = ?`).get(s2.id) as { title: string }
    ).title
    expect(title).toBe('investigate braking failure on route 66'.slice(0, 40))
    expect(session.sessionId).toBe(s2.id)
    await session.stop('stopped')
  })

  // Real CLI shape (verified against the live SDK — see auth-shape-evidence.md), Mode A:
  // not logged in at all. subtype is 'success' — is_error is the only discriminator.
  it('an auth-shaped error result fires onAuthFailure (not-logged-in shape)', async () => {
    const sdk = fakeSdk()
    const onAuthFailure = vi.fn()
    const onAuthVerified = vi.fn()
    const s = makeSession(sdk, { onAuthFailure, onAuthVerified })
    await s.send('hi')
    sdk.messages.push({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
      api_error_status: null
    })
    await flush()
    expect(onAuthFailure).toHaveBeenCalled()
    expect(onAuthVerified).not.toHaveBeenCalled()
  })

  // Real CLI shape, Mode B: invalid/expired API key. Also subtype 'success', but this time
  // api_error_status carries a structured 401 alongside the text.
  it('an auth-shaped error result fires onAuthFailure (invalid-api-key shape)', async () => {
    const sdk = fakeSdk()
    const onAuthFailure = vi.fn()
    const onAuthVerified = vi.fn()
    const s = makeSession(sdk, { onAuthFailure, onAuthVerified })
    await s.send('hi')
    sdk.messages.push({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Invalid API key · Fix external API key',
      api_error_status: 401
    })
    await flush()
    expect(onAuthFailure).toHaveBeenCalled()
    expect(onAuthVerified).not.toHaveBeenCalled()
  })

  // The structured signal alone (api_error_status === 401) must trigger onAuthFailure even
  // when the result text contains none of the known auth phrases.
  it('api_error_status:401 fires onAuthFailure even when the result text is not auth-shaped', async () => {
    const sdk = fakeSdk()
    const onAuthFailure = vi.fn()
    const onAuthVerified = vi.fn()
    const s = makeSession(sdk, { onAuthFailure, onAuthVerified })
    await s.send('hi')
    sdk.messages.push({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'something with no auth words',
      api_error_status: 401
    })
    await flush()
    expect(onAuthFailure).toHaveBeenCalled()
    expect(onAuthVerified).not.toHaveBeenCalled()
  })

  it('a normal result fires onAuthVerified — the turn proves the credentials work', async () => {
    const sdk = fakeSdk()
    const onAuthFailure = vi.fn()
    const onAuthVerified = vi.fn()
    const s = makeSession(sdk, { onAuthFailure, onAuthVerified })
    await s.send('hi')
    sdk.messages.push({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
    await flush()
    expect(onAuthVerified).toHaveBeenCalled()
    expect(onAuthFailure).not.toHaveBeenCalled()
  })

  it('an error result that is not auth-shaped does not fire onAuthFailure', async () => {
    const sdk = fakeSdk()
    const onAuthFailure = vi.fn()
    const onAuthVerified = vi.fn()
    const s = makeSession(sdk, { onAuthFailure, onAuthVerified })
    await s.send('hi')
    sdk.messages.push({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'tool crashed'
    })
    await flush()
    expect(onAuthFailure).not.toHaveBeenCalled()
    expect(onAuthVerified).not.toHaveBeenCalled()
  })

  // Pins the critical-correctness point: the is_error guard in handleResult is what keeps
  // ordinary (non-error) turn output from ever being matched against AUTH_FAILURE_RE. Without
  // it, a successful turn whose result text merely mentions "please login" (e.g. relaying CLI
  // guidance to the user) would wrongly flip the app to logged-out. Verified by temporarily
  // deleting `msg.is_error &&` from the guard: this test fails (onAuthFailure gets called).
  it('a successful result whose text happens to say "please login" does not fire onAuthFailure', async () => {
    const sdk = fakeSdk()
    const onAuthFailure = vi.fn()
    const onAuthVerified = vi.fn()
    const s = makeSession(sdk, { onAuthFailure, onAuthVerified })
    await s.send('hi')
    sdk.messages.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Told the user: please run /login if they see this on their own CLI'
    })
    await flush()
    expect(onAuthFailure).not.toHaveBeenCalled()
    expect(onAuthVerified).toHaveBeenCalled()
  })

  it('records tool detail: memory topic and reference reads land in tool_calls.detail', async () => {
    const sdk = fakeSdk()
    const s = makeSession(sdk, { skillsRoots: [path.join(argusHome, 'references')] })
    s.send('go')
    await flush()
    const canUseTool = sdk.captured.options!.canUseTool as (
      n: string,
      i: Record<string, unknown>,
      o: { signal: AbortSignal }
    ) => Promise<{ behavior: string }>

    await canUseTool(
      'mcp__argus__read_memory',
      { topic: 'nav-drift' },
      { signal: new AbortController().signal }
    )
    await canUseTool(
      'Read',
      { file_path: path.join(argusHome, 'references', 'playbooks', 'triage.md') },
      { signal: new AbortController().signal }
    )
    const rows = db.prepare(`SELECT tool, detail FROM tool_calls ORDER BY id`).all() as {
      tool: string
      detail: string | null
    }[]
    expect(rows).toEqual([
      expect.objectContaining({ tool: 'mcp__argus__read_memory', detail: 'nav-drift' }),
      expect.objectContaining({ tool: 'Read', detail: 'ref:playbooks/triage.md' })
    ])
    await s.stop('stopped')
  })
})

describe('isAuthFailure', () => {
  it('matches the real CLI auth-failure texts', () => {
    expect(isAuthFailure('Not logged in · Please run /login')).toBe(true)
    expect(isAuthFailure('Invalid API key · Fix external API key')).toBe(true)
    expect(isAuthFailure('authentication_error: invalid bearer token')).toBe(true)
  })

  // A bare "401"/"unauthorized" is deliberately NOT matched: real auth-failure text never
  // contains them, and matching would let an unrelated connector's 401 (e.g. an Atlassian
  // call surfacing in a thrown transport error) wrongly mark the user's session logged out.
  // Real 401s are caught structurally via api_error_status in handleResult, not via text.
  it('does not match a bare 401/unauthorized from an unrelated (e.g. connector) error', () => {
    expect(isAuthFailure('API Error: 401 unauthorized')).toBe(false)
  })

  it('does not match ordinary failures', () => {
    expect(isAuthFailure('ENOENT: no such file or directory')).toBe(false)
    expect(isAuthFailure('the tool returned 500')).toBe(false)
  })
})
