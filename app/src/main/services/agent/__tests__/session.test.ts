import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { CaseSession, type CreateQueryFn } from '../session'
import { AsyncQueue } from '../asyncQueue'
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
  const rec = createCase(db, argusHome, { slug: 'NAV-1', title: 't' })
  return new CaseSession({
    db,
    argusHome,
    caseId: rec.id,
    caseSlug: 'NAV-1',
    workspaceRoots: [],
    skillsRoots: [],
    emit: (e) => events.push(e),
    createQuery: sdk.createQuery,
    resumeSdkSessionId: null,
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
    const sess = db.prepare(`SELECT sdk_session_id, turn_count FROM sessions`).get() as {
      sdk_session_id: string
      turn_count: number
    }
    expect(sess.sdk_session_id).toBe('11111111-1111-4111-8111-111111111111')
    expect(sess.turn_count).toBe(1)
    const turn = db.prepare(`SELECT status, input_tokens FROM turns`).get() as {
      status: string
      input_tokens: number
    }
    expect(turn.status).toBe('success')
    expect(turn.input_tokens).toBe(5)
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
    const sess = db.prepare(`SELECT sdk_session_id FROM sessions`).get() as {
      sdk_session_id: string
    }
    expect(sess.sdk_session_id).toBe('11111111-1111-4111-8111-111111111111')
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

  it('applies agentOptions: model, cliPath, permissionMode, personaAppend', async () => {
    const sdk = fakeSdk()
    const rec = createCase(db, argusHome, { slug: 'NAV-OPT', title: 't' })
    const s = new CaseSession({
      db,
      argusHome,
      caseId: rec.id,
      caseSlug: 'NAV-OPT',
      workspaceRoots: [],
      skillsRoots: [],
      emit: (e) => events.push(e),
      createQuery: sdk.createQuery,
      resumeSdkSessionId: null,
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
      caseId: rec2.id,
      caseSlug: 'NAV-DEF',
      workspaceRoots: [],
      skillsRoots: [],
      emit: (e) => events.push(e),
      createQuery: sdk2.createQuery,
      resumeSdkSessionId: null,
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
    const skipEvents = events.filter((e) => e.type === 'session.mcp.skipped')
    expect(skipEvents).toHaveLength(1)
    expect(skipEvents[0].payload).toEqual({ instanceId: 'dead', reason: 'spawn failed' })
    await s.stop('stopped')
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
})
