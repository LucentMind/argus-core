import type { AgentEvent } from '../../../shared/agent-events'

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | { kind: 'tool'; toolCallId: string; name: string; outputPreview: string; done: boolean; isError: boolean }

export interface CaseAgentState {
  items: TranscriptItem[]
  pending: { requestId: string; tool: string; risk: string; grantKey: string | null; argsPreview: string }[]
  running: boolean
  cost: { inputTokens: number; outputTokens: number; costUsd: number }
  sessionNote: string | null
  findingsBump: number
}

const EMPTY: CaseAgentState = {
  items: [], pending: [], running: false,
  cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  sessionNote: null, findingsBump: 0
}

export class AgentStore {
  private byCase = new Map<string, CaseAgentState>()
  private listeners = new Set<() => void>()

  get(caseSlug: string): CaseAgentState {
    return this.byCase.get(caseSlug) ?? EMPTY
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private update(caseSlug: string, mut: (s: CaseAgentState) => CaseAgentState): void {
    this.byCase.set(caseSlug, mut(this.get(caseSlug)))
    for (const cb of this.listeners) cb()
  }

  apply(e: AgentEvent): void {
    this.update(e.caseSlug, (s) => {
      const items = [...s.items]
      const last = items[items.length - 1]
      switch (e.type) {
        case 'turn.started':
          return { ...s, running: true, items: [...items, { kind: 'user', text: e.payload.userText }] }
        case 'content.delta': {
          if (last?.kind === 'assistant' && last.streaming) {
            items[items.length - 1] = { ...last, text: last.text + e.payload.text }
          } else {
            items.push({ kind: 'assistant', text: e.payload.text, streaming: true })
          }
          return { ...s, items }
        }
        case 'assistant.message': {
          if (last?.kind === 'assistant' && last.streaming) {
            items[items.length - 1] = { kind: 'assistant', text: e.payload.text, streaming: false }
          } else {
            items.push({ kind: 'assistant', text: e.payload.text, streaming: false })
          }
          return { ...s, items }
        }
        case 'tool.call.started':
          return {
            ...s,
            items: [...items, {
              kind: 'tool', toolCallId: e.payload.toolCallId, name: e.payload.name,
              outputPreview: '', done: false, isError: false
            }]
          }
        case 'tool.call.completed': {
          const idx = items.findIndex((i) => i.kind === 'tool' && i.toolCallId === e.payload.toolCallId)
          if (idx >= 0) {
            const t = items[idx] as Extract<TranscriptItem, { kind: 'tool' }>
            items[idx] = { ...t, outputPreview: e.payload.outputPreview, done: true, isError: e.payload.isError }
          }
          return { ...s, items }
        }
        case 'request.opened':
          return { ...s, pending: [...s.pending, e.payload] }
        case 'request.resolved':
          return { ...s, pending: s.pending.filter((p) => p.requestId !== e.payload.requestId) }
        case 'turn.completed':
          return {
            ...s, running: false,
            cost: {
              inputTokens: s.cost.inputTokens + (e.payload.inputTokens ?? 0),
              outputTokens: s.cost.outputTokens + (e.payload.outputTokens ?? 0),
              costUsd: s.cost.costUsd + (e.payload.costUsd ?? 0)
            }
          }
        case 'case.finding.added':
          return { ...s, findingsBump: s.findingsBump + 1 }
        case 'session.error':
          return { ...s, sessionNote: `Session error: ${e.payload.message}` }
        case 'session.exited':
          return { ...s, running: false, sessionNote: e.payload.reason === 'crashed' ? 'Session crashed — next message restarts it.' : null }
        default:
          return s
      }
    })
  }
}

export const agentStore = new AgentStore()

let wired = false
export function wireAgentStore(): void {
  if (wired || typeof window === 'undefined' || !window.argus?.agent) return
  wired = true
  window.argus.agent.onEvent((e) => agentStore.apply(e))
}
