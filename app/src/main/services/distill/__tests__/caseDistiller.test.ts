import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { runCaseDistill, runCaseDistillAgent, DistillAgentRunError } from '../caseDistiller'
import { DistillParseError } from '../contract'
import { DISTILL_ALLOWED_TOOLS, DISTILL_MAX_ITERATIONS } from '../worldTools'
import type { CaseDistillInput, DistillWorld } from '../../../../shared/distill'
import type { HeadlessAgentResult, HeadlessResult } from '../../agent/driver'

const INPUT: CaseDistillInput = {
  caseMeta: {
    slug: 'c1',
    title: 'T',
    jiraKey: null,
    status: 'closed',
    resolution: 'solved',
    tags: [],
    createdAt: 'a',
    closedAt: 'b'
  },
  findings: [],
  evidence: [],
  sessionTitles: [],
  skillsIndex: [],
  referencesIndex: [],
  rcaStructure: null,
  alreadyCaptured: { proposals: [] }
}

describe('runCaseDistill', () => {
  it('returns parsed output on valid JSON', async () => {
    const run = await runCaseDistill(INPUT, async () => ({ text: '```json\n{}\n```' }))
    expect(run.output).toEqual({})
    expect(run.raw).toContain('```json')
  })

  it('throws DistillParseError with raw preserved on invalid output', async () => {
    await expect(runCaseDistill(INPUT, async () => ({ text: 'no json here' }))).rejects.toThrow(
      DistillParseError
    )
  })

  it('passes the built prompt to the injected runner and parses its text', async () => {
    let seen = ''
    const run = async (prompt: string): Promise<HeadlessResult> => {
      seen = prompt
      return {
        text: '```json\n{"proposals":[{"type":"reference-edit","target":"a-topic","title":"t","content":"c"}]}\n```'
      }
    }
    const result = await runCaseDistill(INPUT, run)
    expect(seen).toContain('# Case')
    expect(result.output.proposals).toHaveLength(1)
    expect(result.raw).toContain('```json')
  })

  it('forwards the abort signal to the runner', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const ac = new AbortController()
    await runCaseDistill(
      INPUT,
      async (_p, o) => {
        seen.push(o?.signal)
        return { text: '```json\n{}\n```' }
      },
      undefined,
      ac.signal
    )
    expect(seen[0]).toBe(ac.signal)
  })
})

function agentResult(over: Partial<HeadlessAgentResult> = {}): HeadlessAgentResult {
  return {
    text: '```json\n{}\n```',
    turnCount: 3,
    toolCallCount: 2,
    trajectory: [],
    ...over
  }
}

/** Connects an in-memory MCP client to the captured server and calls `list_sessions`, so a
 *  test can assert on the SNAPSHOT it was built over without reaching into private state. */
async function listSessionsViaServer(server: unknown): Promise<unknown> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-distill-agent-client', version: '1.0.0' })
  const instance = (server as { instance: { connect: (t: unknown) => Promise<void> } }).instance
  await Promise.all([client.connect(clientTransport), instance.connect(serverTransport)])
  try {
    const res = await client.callTool({ name: 'list_sessions', arguments: {} })
    const content = res.content as { type: string; text: string }[]
    return JSON.parse(content[0].text)
  } finally {
    await client.close()
  }
}

describe('runCaseDistillAgent', () => {
  it('builds the prompt, wires DISTILL_ALLOWED_TOOLS/DISTILL_MAX_ITERATIONS, and parses the runner text', async () => {
    let seenPrompt = ''
    let seenOpts: { mcpServer: unknown; allowedTools: string[]; maxIterations: number } | null =
      null
    const runAgent = async (
      prompt: string,
      opts: { mcpServer: unknown; allowedTools: string[]; maxIterations: number }
    ): Promise<HeadlessAgentResult> => {
      seenPrompt = prompt
      seenOpts = opts
      return agentResult({
        text: '```json\n{"proposals":[{"type":"reference-edit","target":"a-topic","title":"t","content":"c"}]}\n```',
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02, durationMs: 900 },
        turnCount: 4,
        toolCallCount: 7,
        trajectory: [{ turn: 1, tool: 'mcp__argus__list_sessions', argsSummary: '{}' }]
      })
    }
    const result = await runCaseDistillAgent(INPUT, runAgent)
    expect(seenPrompt).toContain('# Case')
    expect(seenOpts!.allowedTools).toBe(DISTILL_ALLOWED_TOOLS)
    expect(seenOpts!.maxIterations).toBe(DISTILL_MAX_ITERATIONS)
    expect(seenOpts!.mcpServer).toBeTruthy()
    expect(result.promptChars).toBe(seenPrompt.length)
    expect(result.output.proposals).toHaveLength(1)
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.02,
      durationMs: 900
    })
    expect(result.turnCount).toBe(4)
    expect(result.toolCallCount).toBe(7)
    expect(result.trajectory).toHaveLength(1)
  })

  it('reports the agent phase once before the run', async () => {
    const seen: string[] = []
    await runCaseDistillAgent(
      INPUT,
      async () => agentResult(),
      undefined,
      undefined,
      (u) => seen.push(u.phase)
    )
    expect(seen).toEqual(['agent'])
  })

  it('defaults the MCP world to {sessions: []} when input.world is absent', async () => {
    let mcpServer: unknown
    await runCaseDistillAgent(INPUT, async (_p, opts) => {
      mcpServer = opts.mcpServer
      return agentResult()
    })
    expect(await listSessionsViaServer(mcpServer)).toEqual([])
  })

  it('creates the MCP server over input.world when present', async () => {
    const world: DistillWorld = {
      sessions: [{ id: 1, title: 'S', messages: [{ role: 'user', content: 'hi' }] }]
    }
    let mcpServer: unknown
    await runCaseDistillAgent({ ...INPUT, world }, async (_p, opts) => {
      mcpServer = opts.mcpServer
      return agentResult()
    })
    expect(await listSessionsViaServer(mcpServer)).toEqual([
      { id: 1, title: 'S', messageCount: 1, droppedMessages: 0 }
    ])
  })

  it('throws DistillAgentRunError — never parses text as success — when the run reports capHit, carrying raw text + usage/turn/tool/trajectory', async () => {
    const traj = [{ turn: 1, tool: 'x', argsSummary: '{}' }]
    const runAgent = async (): Promise<HeadlessAgentResult> =>
      agentResult({
        text: 'STALE ```json\n{"garbage":true}\n```',
        capHit: 'iterations',
        capSubtype: 'error_max_turns',
        usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.01, durationMs: 500 },
        turnCount: 50,
        toolCallCount: 40,
        trajectory: traj
      })
    let caught: unknown
    try {
      await runCaseDistillAgent(INPUT, runAgent)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DistillAgentRunError)
    expect(caught).toBeInstanceOf(DistillParseError)
    const err = caught as DistillAgentRunError
    expect(err.message).toContain('iterations')
    expect(err.message).toContain('error_max_turns')
    expect(err.raw).toContain('STALE')
    expect(err.agentMeta?.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.01,
      durationMs: 500
    })
    expect(err.agentMeta?.turnCount).toBe(50)
    expect(err.agentMeta?.toolCallCount).toBe(40)
    expect(err.agentMeta?.trajectory).toEqual(traj)
    expect(err.agentMeta?.promptChars).toBeGreaterThan(0)
  })

  it('a CLEAN run (no capHit) whose text still fails to parse also throws DistillAgentRunError carrying agentMeta — not a bare DistillParseError with no cost', async () => {
    const traj = [{ turn: 1, tool: 'mcp__argus__search_transcript', argsSummary: '{}' }]
    const runAgent = async (): Promise<HeadlessAgentResult> =>
      agentResult({
        text: 'the agent forgot to fence its answer',
        usage: { inputTokens: 20, outputTokens: 30, costUsd: 0.03, durationMs: 1200 },
        turnCount: 6,
        toolCallCount: 3,
        trajectory: traj
      })
    let caught: unknown
    try {
      await runCaseDistillAgent(INPUT, runAgent)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DistillAgentRunError)
    const err = caught as DistillAgentRunError
    expect(err.capHit).toBeUndefined() // this was a clean run, not a budget cutoff
    expect(err.raw).toBe('the agent forgot to fence its answer')
    expect(err.agentMeta?.usage).toEqual({
      inputTokens: 20,
      outputTokens: 30,
      costUsd: 0.03,
      durationMs: 1200
    })
    expect(err.agentMeta?.turnCount).toBe(6)
    expect(err.agentMeta?.toolCallCount).toBe(3)
    expect(err.agentMeta?.trajectory).toEqual(traj)
  })

  it('capHit with no capSubtype (a wall-clock timeout) still produces a clear message', async () => {
    const runAgent = async (): Promise<HeadlessAgentResult> =>
      agentResult({ text: '', capHit: 'timeout' })
    await expect(runCaseDistillAgent(INPUT, runAgent)).rejects.toMatchObject({
      message: expect.stringContaining('timeout')
    })
  })

  it('forwards the abort signal to the runner', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const ac = new AbortController()
    await runCaseDistillAgent(
      INPUT,
      async (_p, o) => {
        seen.push(o.signal)
        return agentResult()
      },
      undefined,
      ac.signal
    )
    expect(seen[0]).toBe(ac.signal)
  })
})
