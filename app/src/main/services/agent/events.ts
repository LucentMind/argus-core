import crypto from 'node:crypto'
import type { AgentEvent, AgentEventBase } from '../../../shared/agent-events'

export interface NormalizeCtx {
  caseId: number
  caseSlug: string
  sessionId: number
  turnId: number | null
}

type EventOf<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>

export function makeEvent<T extends AgentEvent['type']>(
  ctx: NormalizeCtx,
  type: T,
  payload: EventOf<T>['payload']
): AgentEvent {
  const base: AgentEventBase = {
    eventId: crypto.randomUUID(),
    caseId: ctx.caseId,
    caseSlug: ctx.caseSlug,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    ts: new Date().toISOString()
  }
  return { ...base, type, payload } as AgentEvent
}
