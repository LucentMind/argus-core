import { describe, it, expect } from 'vitest'
import { normalizeSdkMessage } from '../normalize'
import { AsyncQueue } from '../asyncQueue'

const ctx = { caseId: 1, caseSlug: 'NAV-1', sessionId: 7, turnId: 3 }

describe('AsyncQueue', () => {
  it('yields pushed values in order and terminates on end()', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.end()
    const seen: number[] = []
    for await (const v of q) seen.push(v)
    expect(seen).toEqual([1, 2])
  })
})

describe('normalizeSdkMessage', () => {
  it('maps system/init to session.started', () => {
    const evs = normalizeSdkMessage(
      { type: 'system', subtype: 'init', session_id: 'abc', model: 'claude-sonnet-5' },
      ctx
    )
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({
      type: 'session.started',
      caseId: 1,
      sessionId: 7,
      payload: { model: 'claude-sonnet-5' }
    })
    expect(evs[0].eventId).toBeTruthy()
  })

  it('maps text deltas to content.delta', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'stream_event',
        session_id: 'abc',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }
      },
      ctx
    )
    expect(evs[0]).toMatchObject({ type: 'content.delta', payload: { text: 'hi' } })
  })

  it('maps tool_use start and tool_result to tool call events', () => {
    const start = normalizeSdkMessage(
      {
        type: 'stream_event',
        session_id: 'abc',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 't1', name: 'Bash' }
        }
      },
      ctx
    )
    expect(start[0]).toMatchObject({
      type: 'tool.call.started',
      payload: { toolCallId: 't1', name: 'Bash' }
    })

    const done = normalizeSdkMessage(
      {
        type: 'user',
        session_id: 'abc',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }]
        }
      },
      ctx
    )
    expect(done[0]).toMatchObject({
      type: 'tool.call.completed',
      payload: { toolCallId: 't1', isError: false }
    })
  })

  it('maps assistant text blocks to assistant.message', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'assistant',
        session_id: 'abc',
        message: { role: 'assistant', content: [{ type: 'text', text: 'The root cause…' }] }
      },
      ctx
    )
    expect(evs[0]).toMatchObject({ type: 'assistant.message', payload: { text: 'The root cause…' } })
  })

  it('maps result to turn.completed with usage', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        session_id: 'abc',
        usage: { input_tokens: 100, output_tokens: 20 },
        total_cost_usd: 0.01,
        duration_ms: 900,
        is_error: false
      },
      ctx
    )
    expect(evs[0]).toMatchObject({
      type: 'turn.completed',
      payload: { status: 'success', inputTokens: 100, outputTokens: 20, costUsd: 0.01 }
    })
  })

  it('returns [] for messages it does not surface', () => {
    expect(normalizeSdkMessage({ type: 'system', subtype: 'hook_event' }, ctx)).toEqual([])
  })
})
