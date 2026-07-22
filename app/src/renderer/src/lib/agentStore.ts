import type { AgentEvent } from '../../../shared/agent-events'

export type TranscriptItem =
  | { kind: 'user'; text: string; turnId: number | null }
  | { kind: 'assistant'; text: string; streaming: boolean; turnId: number | null }
  | {
      kind: 'tool'
      toolCallId: string
      name: string
      outputPreview: string
      done: boolean
      isError: boolean
    }

export type PendingDialog = Extract<AgentEvent, { type: 'dialog.opened' }>['payload']

export interface CaseAgentState {
  items: TranscriptItem[]
  pending: {
    requestId: string
    tool: string
    risk: string
    grantKey: string | null
    argsPreview: string
    input?: Record<string, unknown>
  }[]
  pendingDialogs: PendingDialog[]
  running: boolean
  cost: { inputTokens: number; outputTokens: number; costUsd: number }
  sessionNote: string | null
  findingsBump: number
}

export const EMPTY_CASE_AGENT_STATE: CaseAgentState = {
  items: [],
  pending: [],
  pendingDialogs: [],
  running: false,
  cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  sessionNote: null,
  findingsBump: 0
}

const keyOf = (slug: string, sessionId: number): string => `${slug}#${sessionId}`

export class AgentStore {
  // Keyed by `${caseSlug}#${sessionId}` — two sessions in the same case keep
  // fully separate transcripts, running/pending state, and hydrate guards.
  private byCase = new Map<string, CaseAgentState>()
  private listeners = new Set<() => void>()

  get(caseSlug: string, sessionId: number): CaseAgentState {
    return this.byCase.get(keyOf(caseSlug, sessionId)) ?? EMPTY_CASE_AGENT_STATE
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private update(
    caseSlug: string,
    sessionId: number,
    mut: (s: CaseAgentState) => CaseAgentState
  ): void {
    this.byCase.set(keyOf(caseSlug, sessionId), mut(this.get(caseSlug, sessionId)))
    for (const cb of this.listeners) cb()
  }

  /**
   * Replay persisted history into a session that has no live state yet.
   * Stale pending approvals are dropped (unanswerable after a restart) and
   * running is cleared — only live events may set them. The guard is per
   * session, not per case, so hydrating one session never no-ops a sibling
   * session in the same case.
   */
  hydrate(caseSlug: string, sessionId: number, events: AgentEvent[]): void {
    if (this.byCase.get(keyOf(caseSlug, sessionId))?.items.length) return
    for (const e of events) this.applyToState(e)
    this.update(caseSlug, sessionId, (s) => ({
      ...s,
      pending: [],
      pendingDialogs: [],
      running: false
    }))
  }

  private applyToState(e: AgentEvent): void {
    const key = keyOf(e.caseSlug, e.sessionId)
    this.byCase.set(key, this.reduce(this.byCase.get(key) ?? EMPTY_CASE_AGENT_STATE, e))
  }

  apply(e: AgentEvent): void {
    this.update(e.caseSlug, e.sessionId, (s) => this.reduce(s, e))
  }

  private reduce(s: CaseAgentState, e: AgentEvent): CaseAgentState {
    {
      const items = [...s.items]
      const last = items[items.length - 1]
      switch (e.type) {
        case 'turn.started':
          return {
            ...s,
            running: true,
            items: [...items, { kind: 'user', text: e.payload.userText, turnId: e.turnId }]
          }
        case 'content.delta': {
          if (last?.kind === 'assistant' && last.streaming) {
            items[items.length - 1] = { ...last, text: last.text + e.payload.text }
          } else {
            items.push({
              kind: 'assistant',
              text: e.payload.text,
              streaming: true,
              turnId: e.turnId
            })
          }
          return { ...s, items }
        }
        case 'assistant.message': {
          if (last?.kind === 'assistant' && last.streaming) {
            items[items.length - 1] = {
              kind: 'assistant',
              text: e.payload.text,
              streaming: false,
              turnId: e.turnId
            }
          } else {
            items.push({
              kind: 'assistant',
              text: e.payload.text,
              streaming: false,
              turnId: e.turnId
            })
          }
          return { ...s, items }
        }
        case 'tool.call.started':
          return {
            ...s,
            items: [
              ...items,
              {
                kind: 'tool',
                toolCallId: e.payload.toolCallId,
                name: e.payload.name,
                outputPreview: '',
                done: false,
                isError: false
              }
            ]
          }
        case 'tool.call.completed': {
          const idx = items.findIndex(
            (i) => i.kind === 'tool' && i.toolCallId === e.payload.toolCallId
          )
          if (idx >= 0) {
            const t = items[idx] as Extract<TranscriptItem, { kind: 'tool' }>
            items[idx] = {
              ...t,
              outputPreview: e.payload.outputPreview,
              done: true,
              isError: e.payload.isError
            }
          }
          return { ...s, items }
        }
        case 'request.opened':
          return { ...s, pending: [...s.pending, e.payload] }
        case 'request.resolved':
          return { ...s, pending: s.pending.filter((p) => p.requestId !== e.payload.requestId) }
        case 'dialog.opened':
          return { ...s, pendingDialogs: [...s.pendingDialogs, e.payload] }
        case 'dialog.resolved':
          return {
            ...s,
            pendingDialogs: s.pendingDialogs.filter((d) => d.dialogId !== e.payload.dialogId)
          }
        case 'turn.completed':
          return {
            ...s,
            running: false,
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
          return {
            ...s,
            running: false,
            sessionNote:
              e.payload.reason === 'crashed' ? 'Session crashed — next message restarts it.' : null
          }
        default:
          return s
      }
    }
  }
}

export const agentStore = new AgentStore()

let wired = false
export function wireAgentStore(): void {
  if (wired || typeof window === 'undefined' || !window.argus?.agent) return
  wired = true
  window.argus.agent.onEvent((e) => agentStore.apply(e))
}
