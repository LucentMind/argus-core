import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../../../db'
import { createDetection } from '../../../../packs/detection'
import { createClaudeDriver, type CreateQueryFn } from '../index'
import type { NativeToolDeps } from '../../../nativeTools'
import type { DatabaseSync } from 'node:sqlite'

let tmp: string, argusHome: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-driver-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
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

function fakeQuery(messages: unknown[]): CreateQueryFn {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
    },
    interrupt: async () => undefined
  })
}

const baseCtx = (): Parameters<ReturnType<typeof createClaudeDriver>['createSession']>[0] => ({
  caseDir: tmp,
  additionalDirectories: [],
  skills: [],
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

  it('rejects a non-UUID resume cursor (Claude cursor validation lives in the driver)', () => {
    const spy = vi.fn(fakeQuery([]))
    createClaudeDriver(spy).createSession({ ...baseCtx(), resumeCursor: 'copilot-abc' })
    expect((spy.mock.calls[0][0].options as Record<string, unknown>).resume).toBeUndefined()
  })

  it('passes a UUID resume cursor through as the resume option', () => {
    const spy = vi.fn(fakeQuery([]))
    createClaudeDriver(spy).createSession({
      ...baseCtx(),
      resumeCursor: '11111111-1111-4111-8111-111111111111'
    })
    expect((spy.mock.calls[0][0].options as Record<string, unknown>).resume).toBe(
      '11111111-1111-4111-8111-111111111111'
    )
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
    const first = (await captured![Symbol.asyncIterator]().next()).value as {
      type: string
      message: { content: [{ text: string }] }
    }
    expect(first.type).toBe('user')
    expect(first.message.content[0].text).toBe('analyze the crash')
  })
})
