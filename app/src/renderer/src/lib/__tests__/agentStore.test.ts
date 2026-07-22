import { describe, it, expect, beforeEach } from 'vitest'
import { AgentStore } from '../agentStore'
import type { AgentEvent } from '../../../../shared/agent-events'

let store: AgentStore
const base = {
  eventId: 'e',
  caseId: 1,
  caseSlug: 'NAV-1',
  sessionId: 1,
  turnId: 1,
  ts: '2026-07-09T00:00:00Z'
}
const ev = (type: string, payload: unknown): AgentEvent =>
  ({ ...base, type, payload }) as AgentEvent

beforeEach(() => {
  store = new AgentStore()
})

describe('AgentStore', () => {
  it('accumulates streaming text into one assistant item', () => {
    store.apply(ev('turn.started', { userText: 'hi' }))
    store.apply(ev('content.delta', { text: 'Hel' }))
    store.apply(ev('content.delta', { text: 'lo' }))
    const st = store.get('NAV-1', 1)
    expect(st.running).toBe(true)
    expect(st.items).toHaveLength(2)
    expect(st.items[1]).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: true })
  })

  // search jumps resolve a hit's (turnId, role) to a transcript item, so
  // assistant items must carry the turn id just like user items do
  it('carries the turn id on assistant items (streamed and finalized)', () => {
    const at = (type: string, payload: unknown, turnId: number): AgentEvent =>
      ({ ...base, type, payload, turnId }) as AgentEvent
    store.apply(at('turn.started', { userText: 'q' }, 7))
    store.apply(at('content.delta', { text: 'par' }, 7))
    const streaming = store.get('NAV-1', 1).items[1]
    expect(streaming).toMatchObject({ kind: 'assistant', turnId: 7 })
    store.apply(at('assistant.message', { text: 'partial done' }, 7))
    store.apply(at('assistant.message', { text: 'second block' }, 7))
    const st = store.get('NAV-1', 1)
    expect(st.items[1]).toMatchObject({ kind: 'assistant', text: 'partial done', turnId: 7 })
    expect(st.items[2]).toMatchObject({ kind: 'assistant', text: 'second block', turnId: 7 })
  })

  it('finalizes assistant text on assistant.message and stops on turn.completed', () => {
    store.apply(ev('turn.started', { userText: 'hi' }))
    store.apply(ev('content.delta', { text: 'partial' }))
    store.apply(ev('assistant.message', { text: 'final text' }))
    store.apply(
      ev('turn.completed', {
        status: 'success',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
        durationMs: 5
      })
    )
    const st = store.get('NAV-1', 1)
    expect(st.items[1]).toMatchObject({ kind: 'assistant', text: 'final text', streaming: false })
    expect(st.running).toBe(false)
    expect(st.cost).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it('tracks tool calls and pending approvals per case', () => {
    store.apply(ev('tool.call.started', { toolCallId: 't1', name: 'Bash' }))
    store.apply(
      ev('tool.call.completed', {
        toolCallId: 't1',
        name: 'Bash',
        outputPreview: 'ok',
        isError: false
      })
    )
    store.apply(
      ev('request.opened', {
        requestId: 'r1',
        tool: 'Bash',
        risk: 'HIGH',
        grantKey: null,
        argsPreview: 'git push'
      })
    )
    let st = store.get('NAV-1', 1)
    expect(st.items[0]).toMatchObject({ kind: 'tool', name: 'Bash', done: true })
    expect(st.pending).toHaveLength(1)
    store.apply(ev('request.resolved', { requestId: 'r1', decision: 'deny' }))
    st = store.get('NAV-1', 1)
    expect(st.pending).toHaveLength(0)
  })

  it('isolates cases', () => {
    store.apply(ev('content.delta', { text: 'a' }))
    expect(store.get('OTHER', 1).items).toHaveLength(0)
  })

  it('hydrate replays history into an empty case, dropping stale pending/running', () => {
    store.hydrate('NAV-1', 1, [
      ev('turn.started', { userText: 'hi' }),
      ev('assistant.message', { text: 'answer [evidence/log.txt:1]' }),
      ev('request.opened', {
        requestId: 'r1',
        tool: 'Bash',
        risk: 'HIGH',
        grantKey: null,
        argsPreview: 'git push'
      }),
      ev('turn.completed', {
        status: 'success',
        inputTokens: 7,
        outputTokens: 3,
        costUsd: 0.02,
        durationMs: 5
      }),
      ev('turn.started', { userText: 'again' })
    ])
    const st = store.get('NAV-1', 1)
    expect(st.items).toHaveLength(3)
    expect(st.cost.inputTokens).toBe(7)
    expect(st.pending).toHaveLength(0) // stale approvals are unanswerable after restart
    expect(st.running).toBe(false)
  })

  it('hydrate is a no-op when the case already has live state', () => {
    store.apply(ev('turn.started', { userText: 'live' }))
    store.hydrate('NAV-1', 1, [ev('assistant.message', { text: 'old history' })])
    const st = store.get('NAV-1', 1)
    expect(st.items).toHaveLength(1)
    expect(st.items[0]).toMatchObject({ kind: 'user', text: 'live' })
  })

  it('keeps transcripts of two sessions in the same case separate', () => {
    store.apply({
      ...base,
      sessionId: 1,
      type: 'turn.started',
      payload: { userText: 'a' }
    } as AgentEvent)
    store.apply({
      ...base,
      sessionId: 2,
      type: 'turn.started',
      payload: { userText: 'b' }
    } as AgentEvent)
    expect(store.get('NAV-1', 1).items).toHaveLength(1)
    expect(store.get('NAV-1', 2).items).toHaveLength(1)
    expect((store.get('NAV-1', 1).items[0] as { text: string }).text).toBe('a')
  })

  it('hydrate guard is per session, not per case', () => {
    store.hydrate('NAV-1', 1, [
      { ...base, sessionId: 1, type: 'turn.started', payload: { userText: 'a' } } as AgentEvent
    ])
    store.hydrate('NAV-1', 2, [
      { ...base, sessionId: 2, type: 'turn.started', payload: { userText: 'b' } } as AgentEvent
    ])
    expect(store.get('NAV-1', 2).items).toHaveLength(1)
  })
})

describe('AgentStore Question dialogs', () => {
  const q = [
    { question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A', description: 'a' }] }
  ]

  it('appends on dialog.opened and removes on dialog.resolved', () => {
    store.apply(ev('dialog.opened', { dialogId: 'd1', questions: q }))
    expect(store.get('NAV-1', 1).pendingDialogs).toHaveLength(1)
    expect(store.get('NAV-1', 1).pendingDialogs[0]).toMatchObject({ dialogId: 'd1', questions: q })
    store.apply(ev('dialog.resolved', { dialogId: 'd1', behavior: 'completed' }))
    expect(store.get('NAV-1', 1).pendingDialogs).toHaveLength(0)
  })

  it('hydrate drops stale pending dialogs (unanswerable after restart)', () => {
    store.hydrate('NAV-1', 1, [
      { ...base, type: 'dialog.opened', payload: { dialogId: 'd9', questions: q } } as AgentEvent
    ])
    expect(store.get('NAV-1', 1).pendingDialogs).toEqual([])
  })
})
