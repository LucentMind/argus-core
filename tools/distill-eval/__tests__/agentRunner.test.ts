import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  claudeAgentRunner,
  createReplayMcpServer,
  REPLAY_PTC_UNAVAILABLE,
  REPLAY_WORLD_UNAVAILABLE,
  type CreateQueryFn,
  type ReplayQueryOptions
} from '../src/agentRunner'
import {
  DISTILL_ALLOWED_TOOLS,
  DISTILL_MAX_ITERATIONS
} from '../../../app/src/main/services/distill/worldTools'
import type { DistillWorld } from '../../../app/src/shared/distill'

const WORLD: DistillWorld = {
  sessions: [
    {
      id: 1,
      title: 'only session',
      messages: [
        { role: 'user', content: 'the flaky NEEDLE test keeps failing' },
        { role: 'assistant', content: 'looking into it' }
      ]
    }
  ]
}

const assistant = (text: string): unknown => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] }
})
const resultMsg = (subtype = 'success'): unknown => ({ type: 'result', subtype, num_turns: 2 })

interface Captured {
  prompt: string
  options: ReplayQueryOptions
}

/** The one seam that would otherwise spawn the SDK's bundled CLI. No model, no subprocess. */
function fakeCreateQuery(
  messages: unknown[],
  captured: Captured[],
  interrupts: { count: number } = { count: 0 }
): CreateQueryFn {
  return (args) => {
    captured.push({ prompt: args.prompt, options: args.options })
    const gen = (async function* () {
      for (const m of messages) yield m
    })()
    return Object.assign(gen, {
      interrupt: async (): Promise<void> => {
        interrupts.count++
      }
    })
  }
}

async function connected(w: DistillWorld | null): Promise<{ client: Client; close: () => Promise<void> }> {
  return connectServer(createReplayMcpServer(w))
}

/** Connect a client to an already-built server — used to inspect the server the RUNNER assembled,
 *  not just one the test built itself. */
async function connectServer(
  server: ReplayQueryOptions['mcpServers']['argus']
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'replay-test-client', version: '1.0.0' })
  await Promise.all([client.connect(clientTransport), server.instance.connect(serverTransport)])
  return { client, close: async () => client.close() }
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await client.callTool({ name, arguments: args })
  return (res.content as { type: string; text: string }[])[0].text
}

describe('claudeAgentRunner', () => {
  it('assembles the same containment options the app uses and returns the last assistant text', async () => {
    const captured: Captured[] = []
    const interrupts = { count: 0 }
    const run = claudeAgentRunner(undefined, fakeCreateQuery(
      [assistant('first pass'), assistant('```json\n{}\n```'), resultMsg()],
      captured,
      interrupts
    ))

    const outcome = await run('THE PROMPT', WORLD)

    expect(outcome).toEqual({ text: '```json\n{}\n```' })
    expect(captured).toHaveLength(1)
    expect(captured[0].prompt).toBe('THE PROMPT')
    const o = captured[0].options
    expect(o.maxTurns).toBe(DISTILL_MAX_ITERATIONS)
    expect(o.tools).toEqual([])
    // EMPTY on purpose, matching the app: bare allowedTools entries shadow canUseTool
    // (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED, live 2026-08-17); the whitelist lives in the callback.
    expect(o.allowedTools).toEqual([])
    expect(o.allowedTools).not.toEqual(DISTILL_ALLOWED_TOOLS)
    expect(o.mcpServers.argus.name).toBe('argus')
    expect(typeof o.cwd).toBe('string')
    expect(o.cwd.length).toBeGreaterThan(0)
    expect('model' in o).toBe(false)
    // Claude Code's own auto-memory must be OFF, exactly as at the app's spawn sites: it READS
    // too, and injected memories would make the replay a different prompt than the live job's.
    expect(o.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    expect(o.env.PATH ?? o.env.Path).toBeTruthy() // the process.env spread is load-bearing
    // the query is always torn down, exactly like the app's runClaudeHeadlessAgent
    expect(interrupts.count).toBe(1)

    // THE WIRING THAT MATTERS: the server handed to the SDK must serve THIS run's world.
    // Asserting only that `mcpServers.argus` exists passes even if the runner wires up a
    // world-less server, which is exactly the silent-degradation bug this pins.
    const { client, close } = await connectServer(o.mcpServers.argus)
    try {
      expect(JSON.parse(await callText(client, 'list_sessions', {}))).toEqual([
        { id: 1, title: 'only session', messageCount: 2, droppedMessages: 0 }
      ])
      expect(
        JSON.parse(await callText(client, 'search_transcript', { query: 'needle' })).hits
      ).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('wires a world-LESS server (every tool unavailable) when replaying a pre-v2 line', async () => {
    const captured: Captured[] = []
    const run = claudeAgentRunner(undefined, fakeCreateQuery([assistant('ok'), resultMsg()], captured))
    await run('p', null)
    const { client, close } = await connectServer(captured[0].options.mcpServers.argus)
    try {
      expect(await callText(client, 'list_sessions', {})).toBe(REPLAY_WORLD_UNAVAILABLE)
      expect(await callText(client, 'read_transcript', { session_id: 1 })).toBe(REPLAY_WORLD_UNAVAILABLE)
    } finally {
      await close()
    }
  })

  it('harvests a budget-exhausted run as capSubtype instead of grading it silently', async () => {
    const captured: Captured[] = []
    // partial text collected, then the SDK cuts the run off:
    const partial = await claudeAgentRunner(
      undefined,
      fakeCreateQuery([assistant('```json\n{}\n```'), resultMsg('error_max_turns')], captured)
    )('p', WORLD)
    expect(partial).toEqual({ text: '```json\n{}\n```', capSubtype: 'error_max_turns' })

    // nothing collected at all: still a harvested cap, not a throw — the case must be reportable
    const empty = await claudeAgentRunner(
      undefined,
      fakeCreateQuery([resultMsg('error_during_execution')], captured)
    )('p', WORLD)
    expect(empty).toEqual({ text: '', capSubtype: 'error_during_execution' })
  })

  it('passes an explicit model through and gates tools with canUseTool', async () => {
    const captured: Captured[] = []
    const run = claudeAgentRunner('claude-sonnet-4-5', fakeCreateQuery([assistant('ok'), resultMsg()], captured))
    await run('p', null)
    const o = captured[0].options
    expect(o.model).toBe('claude-sonnet-4-5')
    await expect(o.canUseTool('mcp__argus__read_transcript', { session_id: 1 })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { session_id: 1 }
    })
    await expect(o.canUseTool('Bash', { command: 'rm -rf /' })).resolves.toMatchObject({
      behavior: 'deny'
    })
  })

  it('throws only when a CLEAN run produced no text at all (a broken replay, not a capped one)', async () => {
    const captured: Captured[] = []
    await expect(
      claudeAgentRunner(undefined, fakeCreateQuery([resultMsg()], captured))('p', WORLD)
    ).rejects.toThrow(/no text/)
  })
})

describe('createReplayMcpServer', () => {
  it('serves the frozen world through the same worldTools the app uses', async () => {
    const { client, close } = await connected(WORLD)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual([
        'list_sessions',
        'read_transcript',
        'run_tool_script',
        'search_transcript'
      ])
      expect(JSON.parse(await callText(client, 'list_sessions', {}))[0]).toMatchObject({
        id: 1,
        messageCount: 2
      })
      const read = JSON.parse(await callText(client, 'read_transcript', { session_id: 1 }))
      expect(read.total).toBe(2)
      expect(read.messages[0].content).toBe('the flaky NEEDLE test keeps failing')
      const search = JSON.parse(await callText(client, 'search_transcript', { query: 'needle' }))
      expect(search.hits).toHaveLength(1)
      // PTC cannot run here even with a world — it needs the app-side script service
      expect(await callText(client, 'run_tool_script', { script: 'noop' })).toBe(REPLAY_PTC_UNAVAILABLE)
    } finally {
      await close()
    }
  })

  it('keeps every tool REGISTERED with no world, answering the distinguished unavailable error', async () => {
    const { client, close } = await connected(null)
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(4)
      expect(await callText(client, 'list_sessions', {})).toBe(REPLAY_WORLD_UNAVAILABLE)
      expect(await callText(client, 'read_transcript', { session_id: 1 })).toBe(REPLAY_WORLD_UNAVAILABLE)
      expect(await callText(client, 'search_transcript', { query: 'x' })).toBe(REPLAY_WORLD_UNAVAILABLE)
      expect(await callText(client, 'run_tool_script', { script: 'noop' })).toBe(REPLAY_PTC_UNAVAILABLE)
    } finally {
      await close()
    }
  })

  it('advertises the app descriptor text verbatim (tool descriptions are hashed prompt surface)', async () => {
    const { client, close } = await connected(WORLD)
    try {
      const { tools } = await client.listTools()
      const listSessions = tools.find((t) => t.name === 'list_sessions')
      expect(listSessions?.description).toContain('Snapshot-served')
    } finally {
      await close()
    }
  })
})
