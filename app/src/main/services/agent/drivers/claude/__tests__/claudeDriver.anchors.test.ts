import { describe, it, expect, vi } from 'vitest'
import { createClaudeDriver, type CreateQueryFn } from '../index'
import type { DriverSessionContext, TurnResult } from '../../../driver'
import { createDetection } from '../../../../packs/detection'

const SID = '11111111-1111-4111-8111-111111111111'
function scripted(): CreateQueryFn {
  return (args) => ({
    async *[Symbol.asyncIterator]() {
      for await (const _u of args.prompt) {
        void _u
        yield { type: 'system', subtype: 'init', session_id: SID, model: 'claude-sonnet-5' }
        yield {
          type: 'assistant',
          uuid: 'a-1',
          session_id: SID,
          message: { content: [{ type: 'text', text: 'hi' }] }
        }
        yield {
          type: 'assistant',
          uuid: 'a-2',
          session_id: SID,
          message: { content: [{ type: 'text', text: 'there' }] }
        }
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: SID,
          uuid: 'r-1',
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          duration_ms: 1
        }
        break
      }
    },
    interrupt: async () => undefined
  })
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
})
