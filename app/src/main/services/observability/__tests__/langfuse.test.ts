import { describe, it, expect, vi } from 'vitest'
import { LangfuseExporter, type LangfuseClientLike } from '../langfuse'
import type { AgentEvent } from '../../../../shared/agent-events'

function fakeClient(): { client: LangfuseClientLike; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { trace: [], generation: [], span: [], score: [] }
  const client: LangfuseClientLike = {
    trace: (o) => {
      calls.trace.push(o)
      return { update: () => {} }
    },
    generation: (o) => calls.generation.push(o),
    span: (o) => calls.span.push(o),
    score: (o) => calls.score.push(o),
    flushAsync: vi.fn().mockResolvedValue(undefined),
    shutdownAsync: vi.fn().mockResolvedValue(undefined)
  }
  return { client, calls }
}

const base = { eventId: 'e', caseId: 1, caseSlug: 'c1', sessionId: 7, turnId: 3, ts: 't' }

describe('LangfuseExporter', () => {
  it('maps a turn to a generation with usage and omits content when captureContent=false', () => {
    const { client, calls } = fakeClient()
    const ex = new LangfuseExporter(client, { captureContent: false })
    ex.handle({
      ...base,
      type: 'session.started',
      payload: { model: 'claude-opus-4-8', resumed: false }
    } as AgentEvent)
    ex.handle({
      ...base,
      type: 'turn.started',
      payload: { userText: 'secret log line' }
    } as AgentEvent)
    ex.handle({
      ...base,
      type: 'turn.completed',
      payload: {
        status: 'success',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
        durationMs: 100
      }
    } as AgentEvent)
    expect(calls.trace).toHaveLength(1)
    expect(calls.generation).toHaveLength(1)
    const gen = calls.generation[0] as Record<string, unknown>
    expect(gen.model).toBe('claude-opus-4-8')
    expect(JSON.stringify(gen)).not.toContain('secret log line') // content gated OFF
  })

  it('includes content when captureContent=true', () => {
    const { client, calls } = fakeClient()
    const ex = new LangfuseExporter(client, { captureContent: true })
    ex.handle({
      ...base,
      type: 'session.started',
      payload: { model: 'm', resumed: false }
    } as AgentEvent)
    ex.handle({
      ...base,
      type: 'turn.started',
      payload: { userText: 'secret log line' }
    } as AgentEvent)
    ex.handle({
      ...base,
      type: 'turn.completed',
      payload: { status: 'success', inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 }
    } as AgentEvent)
    expect(JSON.stringify(calls.generation[0])).toContain('secret log line')
  })

  it('emits a turn_error score on error turns', () => {
    const { client, calls } = fakeClient()
    const ex = new LangfuseExporter(client, { captureContent: false })
    ex.handle({
      ...base,
      type: 'session.started',
      payload: { model: 'm', resumed: false }
    } as AgentEvent)
    ex.handle({ ...base, type: 'turn.started', payload: { userText: 'x' } } as AgentEvent)
    ex.handle({
      ...base,
      type: 'turn.completed',
      payload: {
        status: 'error',
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        durationMs: null
      }
    } as AgentEvent)
    expect(calls.score).toContainEqual(expect.objectContaining({ name: 'turn_error', value: 1 }))
  })

  it('never throws when the client throws', () => {
    const client = {
      trace: () => {
        throw new Error('down')
      },
      generation: () => {},
      span: () => {},
      score: () => {},
      flushAsync: async () => {},
      shutdownAsync: async () => {}
    } as LangfuseClientLike
    const ex = new LangfuseExporter(client, { captureContent: false })
    expect(() =>
      ex.handle({
        ...base,
        type: 'session.started',
        payload: { model: 'm', resumed: false }
      } as AgentEvent)
    ).not.toThrow()
    expect(ex.lastError()).toContain('down')
  })
})
