import { describe, it, expect, beforeEach } from 'vitest'
import { AgentStore } from '../agentStore'
import type { AgentEvent } from '../../../../shared/agent-events'

let store: AgentStore
const base = {
  eventId: 'e', caseId: 1, caseSlug: 'NAV-1', sessionId: 1, turnId: 1,
  ts: '2026-07-09T00:00:00Z'
}
const ev = (type: string, payload: unknown): AgentEvent => ({ ...base, type, payload }) as AgentEvent

beforeEach(() => {
  store = new AgentStore()
})

describe('AgentStore', () => {
  it('accumulates streaming text into one assistant item', () => {
    store.apply(ev('turn.started', { userText: 'hi' }))
    store.apply(ev('content.delta', { text: 'Hel' }))
    store.apply(ev('content.delta', { text: 'lo' }))
    const st = store.get('NAV-1')
    expect(st.running).toBe(true)
    expect(st.items).toHaveLength(2)
    expect(st.items[1]).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: true })
  })

  it('finalizes assistant text on assistant.message and stops on turn.completed', () => {
    store.apply(ev('turn.started', { userText: 'hi' }))
    store.apply(ev('content.delta', { text: 'partial' }))
    store.apply(ev('assistant.message', { text: 'final text' }))
    store.apply(ev('turn.completed', { status: 'success', inputTokens: 10, outputTokens: 5, costUsd: 0.01, durationMs: 5 }))
    const st = store.get('NAV-1')
    expect(st.items[1]).toMatchObject({ kind: 'assistant', text: 'final text', streaming: false })
    expect(st.running).toBe(false)
    expect(st.cost).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it('tracks tool calls and pending approvals per case', () => {
    store.apply(ev('tool.call.started', { toolCallId: 't1', name: 'Bash' }))
    store.apply(ev('tool.call.completed', { toolCallId: 't1', name: 'Bash', outputPreview: 'ok', isError: false }))
    store.apply(ev('request.opened', { requestId: 'r1', tool: 'Bash', risk: 'HIGH', grantKey: null, argsPreview: 'git push' }))
    let st = store.get('NAV-1')
    expect(st.items[0]).toMatchObject({ kind: 'tool', name: 'Bash', done: true })
    expect(st.pending).toHaveLength(1)
    store.apply(ev('request.resolved', { requestId: 'r1', decision: 'deny' }))
    st = store.get('NAV-1')
    expect(st.pending).toHaveLength(0)
  })

  it('isolates cases', () => {
    store.apply(ev('content.delta', { text: 'a' }))
    expect(store.get('OTHER').items).toHaveLength(0)
  })
})
