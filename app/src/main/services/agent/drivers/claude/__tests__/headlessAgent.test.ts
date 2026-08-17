import os from 'node:os'
import { describe, it, expect, vi } from 'vitest'
import { createClaudeDriver, type CreateQueryFn } from '..'
import { runClaudeHeadlessAgent } from '../headlessAgent'
import { agentScratchCwd } from '../../../scratchCwd'

/** A scripted query handle that yields raw SDK-shaped messages verbatim — unlike
 *  `headless.test.ts`'s `scriptedQuery` (text-only assistant turns), a headless AGENT run
 *  needs full control over which turn carries which content blocks (text vs tool_use), so
 *  each test supplies the exact message sequence rather than a list of strings. */
function scriptedAgentQuery(messages: unknown[]): {
  fn: CreateQueryFn
  interrupts: number
  opts: () => Record<string, unknown>
} {
  let interrupts = 0
  let captured: Record<string, unknown> = {}
  const fn: CreateQueryFn = (args) => {
    captured = args.options
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m
      },
      interrupt: async () => {
        interrupts++
      }
    }
  }
  return {
    fn,
    get interrupts() {
      return interrupts
    },
    opts: () => captured
  } as never
}

/** Same "never settles" fake as `headless.test.ts`'s `hangingQuery`. */
function hangingQuery(): { fn: CreateQueryFn; interrupts: () => number } {
  let interrupts = 0
  const fn: CreateQueryFn = () =>
    ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      interrupt: async () => {
        interrupts++
      }
    }) as never
  return { fn, interrupts: () => interrupts }
}

const baseAgentOpts = {
  argusHome: '/tmp/argus',
  mcpServer: { fake: 'mcp-server' },
  allowedTools: ['mcp__argus__read_transcript'],
  maxIterations: 10
}

describe('claude runHeadlessAgent', () => {
  it('declares the capability and exposes the method', () => {
    const d = createClaudeDriver()
    expect(d.capabilities.headlessAgent).toBe(true)
    expect(typeof d.runHeadlessAgent).toBe('function')
  })

  it('counts turns/tool calls, collects the trajectory, and returns the last assistant text', async () => {
    const q = scriptedAgentQuery([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking about it' }] } },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tc-1',
              name: 'mcp__argus__read_transcript',
              input: { session_id: 'abc-123' }
            }
          ]
        }
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'FINAL\n```json\n{"finding":"ok"}\n```' }]
        }
      },
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.01
      }
    ])
    const d = createClaudeDriver(q.fn)
    const result = await d.runHeadlessAgent!('prompt', baseAgentOpts)
    expect(result.text).toBe('FINAL\n```json\n{"finding":"ok"}\n```')
    expect(result.turnCount).toBe(3)
    expect(result.toolCallCount).toBe(1)
    expect(result.trajectory).toEqual([
      {
        turn: 2,
        tool: 'mcp__argus__read_transcript',
        argsSummary: expect.stringContaining('session_id')
      }
    ])
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 50, costUsd: 0.01 })
  })

  it('passes maxIterations as maxTurns, plus allowedTools and mcpServers, to createQuery', async () => {
    const q = scriptedAgentQuery([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', subtype: 'success' }
    ])
    const d = createClaudeDriver(q.fn)
    await d.runHeadlessAgent!('prompt', { ...baseAgentOpts, maxIterations: 37 })
    expect(q.opts()).toMatchObject({
      maxTurns: 37,
      allowedTools: baseAgentOpts.allowedTools,
      mcpServers: { argus: baseAgentOpts.mcpServer }
    })
  })

  it('pins cwd to the empty scratch dir, same as runHeadless', async () => {
    const q = scriptedAgentQuery([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', subtype: 'success' }
    ])
    const d = createClaudeDriver(q.fn)
    await d.runHeadlessAgent!('prompt', baseAgentOpts)
    expect(q.opts()).toMatchObject({ cwd: agentScratchCwd() })
  })

  it('counts multiple tool_use blocks within one assistant turn separately', async () => {
    const q = scriptedAgentQuery([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tc-1', name: 'tool_a', input: { x: 1 } },
            { type: 'tool_use', id: 'tc-2', name: 'tool_b', input: { y: 2 } }
          ]
        }
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success' }
    ])
    const d = createClaudeDriver(q.fn)
    const result = await d.runHeadlessAgent!('prompt', baseAgentOpts)
    expect(result.toolCallCount).toBe(2)
    expect(result.trajectory).toEqual([
      { turn: 1, tool: 'tool_a', argsSummary: expect.stringContaining('"x":1') },
      { turn: 1, tool: 'tool_b', argsSummary: expect.stringContaining('"y":2') }
    ])
  })

  it('leaves token/cost fields undefined when the result message carries no usage', async () => {
    const q = scriptedAgentQuery([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', subtype: 'success' }
    ])
    const d = createClaudeDriver(q.fn)
    const result = await d.runHeadlessAgent!('prompt', baseAgentOpts)
    expect(result.usage).not.toHaveProperty('inputTokens')
    expect(result.usage).not.toHaveProperty('outputTokens')
    expect(result.usage).not.toHaveProperty('costUsd')
    expect(typeof result.usage?.durationMs).toBe('number')
  })

  it('interrupts the query even when the run throws (no assistant text)', async () => {
    const q = scriptedAgentQuery([{ type: 'result', subtype: 'success' }])
    const d = createClaudeDriver(q.fn)
    await expect(d.runHeadlessAgent!('prompt', baseAgentOpts)).rejects.toThrow(/returned no text/)
    expect(q.interrupts).toBe(1)
  })

  it('falls back to resolveCliPath when opts.cliPath is absent', async () => {
    const q = scriptedAgentQuery([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', subtype: 'success' }
    ])
    const resolveCliPath = vi.fn(() => '/asar-unpacked/claude.exe')
    const result = await runClaudeHeadlessAgent('prompt', baseAgentOpts, q.fn, resolveCliPath)
    expect(result.text).toBe('ok')
    expect(resolveCliPath).toHaveBeenCalledTimes(1)
    expect(q.opts()).toMatchObject({ pathToClaudeCodeExecutable: '/asar-unpacked/claude.exe' })
  })

  it('rejects when the timeout elapses first', async () => {
    vi.useFakeTimers()
    const fn: CreateQueryFn = () => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined)
      },
      interrupt: async () => undefined
    })
    const d = createClaudeDriver(fn)
    const p = d.runHeadlessAgent!('prompt', { ...baseAgentOpts, timeoutMs: 1000 })
    const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/)
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
    vi.useRealTimers()
  })

  it('rejects and interrupts when the signal aborts', async () => {
    const q = hangingQuery()
    const d = createClaudeDriver(q.fn)
    const ac = new AbortController()
    const p = d.runHeadlessAgent!('prompt', {
      ...baseAgentOpts,
      argusHome: os.tmpdir(),
      signal: ac.signal
    })
    ac.abort()
    await expect(p).rejects.toThrow('headless run cancelled')
    expect(q.interrupts()).toBe(1)
  })
})
