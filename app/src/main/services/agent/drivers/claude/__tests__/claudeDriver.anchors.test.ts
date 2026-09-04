import { describe, it, expect, vi } from 'vitest'
import { createClaudeDriver, type CreateQueryFn } from '../index'
import type { DriverSessionContext, TurnResult } from '../../../driver'
import { createDetection } from '../../../../packs/detection'

const SID = '11111111-1111-4111-8111-111111111111'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const defaultScript: any[][] = [
  [
    { type: 'system', subtype: 'init', session_id: SID, model: 'claude-sonnet-5' },
    {
      type: 'assistant',
      uuid: 'a-1',
      session_id: SID,
      message: { content: [{ type: 'text', text: 'hi' }] }
    },
    {
      type: 'assistant',
      uuid: 'a-2',
      session_id: SID,
      message: { content: [{ type: 'text', text: 'there' }] }
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: SID,
      uuid: 'r-1',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      duration_ms: 1
    }
  ]
]

// `script` is a list of per-turn message arrays: one array is consumed (and yielded in
// full) per `send()`, so multi-turn tests can vary what each turn's stream looks like
// (e.g. a turn with no assistant message at all).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scripted(script: any[][] = defaultScript): CreateQueryFn {
  return (args) => {
    let turn = 0
    return {
      async *[Symbol.asyncIterator]() {
        for await (const _u of args.prompt) {
          void _u
          const messages = script[turn] ?? []
          turn++
          for (const msg of messages) yield msg
        }
      },
      interrupt: async () => undefined
    }
  }
}

function ctx(onTurnResult: (r: TurnResult) => void): DriverSessionContext {
  return {
    caseDir: process.cwd(),
    additionalDirectories: [],
    skills: [],
    subagents: [],
    permissionMode: 'default',
    systemAppend: '',
    extraMcpServers: {},
    nativeToolDeps: {
      db: null as never,
      argusHome: '',
      detection: createDetection(),
      caseId: 1,
      caseSlug: 'c',
      sessionId: 1,
      emitFinding: () => {},
      githubWatermark: () => ({ enabled: false, text: '' })
    },
    panelCommandDecls: [],
    resumeCursor: null,
    eventCtx: () => ({ caseId: 1, caseSlug: 'c', sessionId: 1, turnId: 1 }),
    onToolRequest: async () => ({ behavior: 'allow', updatedInput: {} }),
    onCursor: vi.fn(),
    onTurnResult,
    capturePrompt: () => {}
  }
}

describe('claude driver anchors', () => {
  it('reports the LAST assistant uuid of the turn on TurnResult', async () => {
    const results: TurnResult[] = []
    const s = createClaudeDriver(scripted()).createSession(ctx((r) => results.push(r)))
    s.send('x')
    for await (const ev of s.events()) if (ev.type === 'turn.completed') break
    s.end()
    expect(results[0].providerAnchorId).toBe('a-2')
  })

  it('ignores sub-agent assistant messages when picking the anchor', async () => {
    const results: TurnResult[] = []
    const script = [
      [
        { type: 'system', subtype: 'init', session_id: SID, model: 'claude-sonnet-5' },
        {
          type: 'assistant',
          uuid: 'a-1',
          session_id: SID,
          message: { content: [{ type: 'text', text: 'hi' }] }
        },
        {
          type: 'assistant',
          uuid: 'a-sub',
          session_id: SID,
          parent_tool_use_id: 'tool-1',
          message: { content: [{ type: 'text', text: 'sub-agent chatter' }] }
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: SID,
          uuid: 'r-1',
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          duration_ms: 1
        }
      ]
    ]
    const s = createClaudeDriver(scripted(script)).createSession(ctx((r) => results.push(r)))
    s.send('x')
    for await (const ev of s.events()) if (ev.type === 'turn.completed') break
    s.end()
    expect(results[0].providerAnchorId).toBe('a-1')
  })

  it('does not carry an anchor across turns', async () => {
    const results: TurnResult[] = []
    const script = [
      [
        { type: 'system', subtype: 'init', session_id: SID, model: 'claude-sonnet-5' },
        {
          type: 'assistant',
          uuid: 'a-1',
          session_id: SID,
          message: { content: [{ type: 'text', text: 'hi' }] }
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: SID,
          uuid: 'r-1',
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          duration_ms: 1
        }
      ],
      [
        { type: 'system', subtype: 'init', session_id: SID, model: 'claude-sonnet-5' },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: SID,
          uuid: 'r-2',
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          duration_ms: 1
        }
      ]
    ]
    const s = createClaudeDriver(scripted(script)).createSession(ctx((r) => results.push(r)))
    s.send('x')
    s.send('y')
    let completed = 0
    for await (const ev of s.events()) {
      if (ev.type === 'turn.completed') {
        completed++
        if (completed === 2) break
      }
    }
    s.end()
    expect(results[0].providerAnchorId).toBe('a-1')
    expect(results[1].providerAnchorId).toBeNull()
  })
})
