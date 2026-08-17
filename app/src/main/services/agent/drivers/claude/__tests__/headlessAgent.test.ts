import os from 'node:os'
import { describe, it, expect, vi } from 'vitest'
import { createClaudeDriver, type CreateQueryFn } from '..'
import { runClaudeHeadlessAgent } from '../headlessAgent'
import { agentScratchCwd } from '../../../scratchCwd'

/** A scripted query handle that yields raw SDK-shaped messages verbatim — unlike
 *  `headless.test.ts`'s `scriptedQuery` (text-only assistant turns), a headless AGENT run
 *  needs full control over which turn carries which content blocks (text vs tool_use), so
 *  each test supplies the exact message sequence rather than a list of strings. Ignores the
 *  prompt stream entirely — for tests that need to observe/react to what gets pushed onto it
 *  (the budget nudge), see `budgetExhaustionQuery` below. */
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

/**
 * A query handle that ACTUALLY consumes `args.prompt` (unlike `scriptedAgentQuery`), so a test
 * can observe the budget-exhaustion nudge the driver pushes onto it mid-run. On the first
 * prompt turn it emits `maxIterations` plain-text assistant messages and then stalls (real
 * SDK behavior: no `result` until it either finishes or is asked again); on the second prompt
 * turn (the nudge) it emits one final assistant message plus a success result and ends.
 */
function budgetExhaustionQuery(maxIterations: number): {
  fn: CreateQueryFn
  capturedPrompts: string[]
  opts: () => Record<string, unknown>
} {
  const capturedPrompts: string[] = []
  let captured: Record<string, unknown> = {}
  const fn: CreateQueryFn = (args) => {
    captured = args.options
    return {
      async *[Symbol.asyncIterator]() {
        let promptIndex = 0
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const userMsg of args.prompt as AsyncIterable<any>) {
          promptIndex++
          capturedPrompts.push(String(userMsg?.message?.content?.[0]?.text ?? ''))
          if (promptIndex === 1) {
            for (let i = 0; i < maxIterations; i++) {
              yield {
                type: 'assistant',
                message: { content: [{ type: 'text', text: `turn ${i}` }] }
              }
            }
            // No result yet: waits for the next prompt turn (the nudge), same as the real SDK
            // holding the session open past maxIterations turns until maxTurns is reached.
          } else {
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'FINAL after nudge' }] }
            }
            yield { type: 'result', subtype: 'success' }
            return
          }
        }
      },
      interrupt: async () => undefined
    }
  }
  return { fn, capturedPrompts, opts: () => captured }
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
    expect(result.capHit).toBeUndefined()
    expect(result.trajectory).toEqual([
      {
        turn: 2,
        tool: 'mcp__argus__read_transcript',
        argsSummary: expect.stringContaining('session_id')
      }
    ])
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 50, costUsd: 0.01 })
  })

  it('passes maxIterations+1 as maxTurns (headroom for the budget nudge), plus allowedTools and mcpServers, to createQuery', async () => {
    const q = scriptedAgentQuery([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', subtype: 'success' }
    ])
    const d = createClaudeDriver(q.fn)
    await d.runHeadlessAgent!('prompt', { ...baseAgentOpts, maxIterations: 37 })
    expect(q.opts()).toMatchObject({
      maxTurns: 38,
      allowedTools: baseAgentOpts.allowedTools,
      mcpServers: { argus: baseAgentOpts.mcpServer }
    })
  })

  it('disables built-in tools (tools: []) and installs a canUseTool gate', async () => {
    const q = scriptedAgentQuery([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', subtype: 'success' }
    ])
    const d = createClaudeDriver(q.fn)
    await d.runHeadlessAgent!('prompt', baseAgentOpts)
    expect(q.opts()).toMatchObject({ tools: [] })
    expect(typeof q.opts().canUseTool).toBe('function')
  })

  it('canUseTool allows a whitelisted tool and denies everything else — allowedTools only auto-approves, it does not restrict', async () => {
    const q = scriptedAgentQuery([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', subtype: 'success' }
    ])
    const d = createClaudeDriver(q.fn)
    await d.runHeadlessAgent!('prompt', baseAgentOpts)
    const canUseTool = q.opts().canUseTool as (
      name: string,
      input: Record<string, unknown>
    ) => Promise<{ behavior: string; updatedInput?: unknown; message?: string }>
    await expect(canUseTool('mcp__argus__read_transcript', { session_id: 'x' })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { session_id: 'x' }
    })
    await expect(canUseTool('Bash', { command: 'rm -rf /' })).resolves.toEqual({
      behavior: 'deny',
      message: 'not available in distillation'
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

  it('captures resultBytes on a trajectory entry from its matching tool_result block (by tool_use_id)', async () => {
    const q = scriptedAgentQuery([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tc-1',
              name: 'mcp__argus__read_transcript',
              input: { session_id: 'x' }
            }
          ]
        }
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tc-1', content: 'twelve bytes!', is_error: false }
          ]
        }
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success' }
    ])
    const d = createClaudeDriver(q.fn)
    const result = await d.runHeadlessAgent!('prompt', baseAgentOpts)
    expect(result.trajectory).toHaveLength(1)
    expect(result.trajectory[0].resultBytes).toBe(Buffer.byteLength('twelve bytes!', 'utf8'))
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

  it('interrupts the query even when the run throws (no assistant text, plain success)', async () => {
    const q = scriptedAgentQuery([{ type: 'result', subtype: 'success' }])
    const d = createClaudeDriver(q.fn)
    await expect(d.runHeadlessAgent!('prompt', baseAgentOpts)).rejects.toThrow(/returned no text/)
    expect(q.interrupts).toBe(1)
  })

  it('still throws for a plain non-success result with nothing collected (unchanged failure behavior)', async () => {
    const q = scriptedAgentQuery([{ type: 'result', subtype: 'error_during_execution' }])
    const d = createClaudeDriver(q.fn)
    await expect(d.runHeadlessAgent!('prompt', baseAgentOpts)).rejects.toThrow(
      /headless agent run failed: error_during_execution/
    )
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

  it('nudges for a final answer once the assistant turn count hits maxIterations, and harvests the recovered text', async () => {
    const q = budgetExhaustionQuery(3)
    const d = createClaudeDriver(q.fn)
    const result = await d.runHeadlessAgent!('prompt', { ...baseAgentOpts, maxIterations: 3 })
    expect(q.capturedPrompts[0]).toBe('prompt')
    expect(q.capturedPrompts[1]).toBe(
      'Budget exhausted — return your final fenced json block now, based on what you have.'
    )
    expect(result.text).toBe('FINAL after nudge')
    expect(result.turnCount).toBe(4)
    expect(result.capHit).toBeUndefined()
    expect(q.opts()).toMatchObject({ maxTurns: 4 })
  })

  it('harvests partial state and sets capHit "iterations" when the SDK reports error_max_turns despite the nudge', async () => {
    const q = scriptedAgentQuery([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'partial thinking' }] } },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tc-1',
              name: 'mcp__argus__read_transcript',
              input: { session_id: 'x' }
            }
          ]
        }
      },
      {
        type: 'result',
        subtype: 'error_max_turns',
        num_turns: 4,
        usage: { input_tokens: 200, output_tokens: 80 },
        total_cost_usd: 0.02
      }
    ])
    const d = createClaudeDriver(q.fn)
    const result = await d.runHeadlessAgent!('prompt', baseAgentOpts)
    expect(result.capHit).toBe('iterations')
    // M3: the raw SDK subtype is recorded alongside capHit — capHit alone can't tell this
    // (an actual budget cap) apart from a genuine crash like error_during_execution.
    expect(result.capSubtype).toBe('error_max_turns')
    // No FINAL fenced-json block ever arrived, but the harvest is the last non-empty
    // assistant text seen — proves the state isn't thrown away just because the SDK cut
    // the run off. (An empty `text` alongside `capHit` is also a valid, deliberate return
    // when NO assistant text arrived at all — Task 12's parse then fails the job with raw
    // output preserved.)
    expect(result.text).toBe('partial thinking')
    // Preferred from the SDK's own num_turns over the client-observed count (2).
    expect(result.turnCount).toBe(4)
    expect(result.toolCallCount).toBe(1)
    expect(result.trajectory).toHaveLength(1)
    expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 80, costUsd: 0.02 })
    expect(q.interrupts).toBe(1)
  })

  it('returns empty text alongside capHit when the SDK cuts the run off before any assistant text arrived', async () => {
    const q = scriptedAgentQuery([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tc-1',
              name: 'mcp__argus__read_transcript',
              input: { session_id: 'x' }
            }
          ]
        }
      },
      { type: 'result', subtype: 'error_max_turns', num_turns: 1 }
    ])
    const d = createClaudeDriver(q.fn)
    const result = await d.runHeadlessAgent!('prompt', baseAgentOpts)
    expect(result.capHit).toBe('iterations')
    expect(result.text).toBe('')
    expect(result.toolCallCount).toBe(1)
  })

  it('records capSubtype as error_during_execution — distinguishable in the recorded data from an actual budget cap', async () => {
    const q = scriptedAgentQuery([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'crashed mid-thought' }] } },
      { type: 'result', subtype: 'error_during_execution' }
    ])
    const d = createClaudeDriver(q.fn)
    const result = await d.runHeadlessAgent!('prompt', baseAgentOpts)
    expect(result.capHit).toBe('iterations')
    expect(result.capSubtype).toBe('error_during_execution')
  })

  it('resolves with the harvested partial and capHit "timeout" when the wall-clock timeout elapses, instead of throwing', async () => {
    vi.useFakeTimers()
    const fn: CreateQueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'still going' }] } }
        await new Promise(() => undefined) // never settles — the run is still "running" past the timeout
      },
      interrupt: async () => undefined
    })
    const d = createClaudeDriver(fn)
    const p = d.runHeadlessAgent!('prompt', { ...baseAgentOpts, timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1001)
    const result = await p
    expect(result.capHit).toBe('timeout')
    expect(result.capSubtype).toBeUndefined()
    expect(result.text).toBe('still going')
    expect(result.turnCount).toBe(1)
    // M2: no `result` message ever arrived (so no reported tokens/cost), but durationMs — the
    // one figure always knowable — is still synthesized rather than lost on exactly the
    // long-running distill jobs a timeout is most likely to hit.
    expect(result.usage).toEqual({ durationMs: expect.any(Number) })
    vi.useRealTimers()
  })

  it('prefers a real usage figure over the synthesized duration-only fallback when a result DID land moments before the timeout fired', async () => {
    // Regression guard for the `??` in `state.usage ?? { durationMs: ... }`: if a genuine
    // result somehow raced the timer (belt-and-braces — not expected in practice, since a
    // `result` message ends the collector's race outright), the real usage must win, not be
    // clobbered by the synthesized fallback.
    vi.useFakeTimers()
    const fn: CreateQueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'answered' }] }
        }
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 9, output_tokens: 3 },
          total_cost_usd: 0.001
        }
      },
      interrupt: async () => undefined
    })
    const d = createClaudeDriver(fn)
    const result = await d.runHeadlessAgent!('prompt', { ...baseAgentOpts, timeoutMs: 1000 })
    expect(result.capHit).toBeUndefined()
    expect(result.usage).toMatchObject({ inputTokens: 9, outputTokens: 3, costUsd: 0.001 })
    vi.useRealTimers()
  })

  it('returns a defensive COPY of the trajectory — a collector still running after the timeout race must not mutate an already-returned result', async () => {
    vi.useFakeTimers()
    let continueSecondTurn: () => void = () => undefined
    const fn: CreateQueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'tc-1', name: 'mcp__argus__read_transcript', input: { a: 1 } }
            ]
          }
        }
        // Parks here — simulates the gap between the timeout race winning and this
        // (abandoned but not yet interrupted) collector actually stopping.
        await new Promise<void>((resolve) => {
          continueSecondTurn = resolve
        })
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'tc-2', name: 'mcp__argus__read_transcript', input: { b: 2 } }
            ]
          }
        }
      },
      interrupt: async () => undefined
    })
    const d = createClaudeDriver(fn)
    const p = d.runHeadlessAgent!('prompt', { ...baseAgentOpts, timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1001)
    const result = await p
    expect(result.trajectory).toHaveLength(1)
    // Let the abandoned collector push a SECOND tool_use into its internal state, after the
    // result above was already handed back.
    continueSecondTurn()
    await vi.advanceTimersByTimeAsync(0)
    // The already-returned array must be untouched by that late push — proves toResult
    // copied rather than handed out the live array.
    expect(result.trajectory).toHaveLength(1)
    vi.useRealTimers()
  })

  it('rejects and interrupts when the signal aborts (an explicit cancel, not a budget cutoff)', async () => {
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
