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

const PREVIEW_MAX = 2000

function previewOf(content: unknown): string {
  const s =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((b) => (typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : ''))
            .join('')
        : content === null || content === undefined
          ? ''
          : JSON.stringify(content)
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '…' : s
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeSdkMessage(msg: any, ctx: NormalizeCtx): AgentEvent[] {
  if (!msg || typeof msg !== 'object') return []

  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        return [makeEvent(ctx, 'session.started', { model: String(msg.model ?? ''), resumed: false })]
      }
      return []

    case 'stream_event': {
      const ev = msg.event
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        return [makeEvent(ctx, 'content.delta', { text: String(ev.delta.text ?? '') })]
      }
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        return [
          makeEvent(ctx, 'tool.call.started', {
            toolCallId: String(ev.content_block.id),
            name: String(ev.content_block.name)
          })
        ]
      }
      return []
    }

    case 'assistant': {
      const text = (msg.message?.content ?? [])
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('')
      return text ? [makeEvent(ctx, 'assistant.message', { text })] : []
    }

    case 'user': {
      const out: AgentEvent[] = []
      for (const block of msg.message?.content ?? []) {
        if (block?.type === 'tool_result') {
          out.push(
            makeEvent(ctx, 'tool.call.completed', {
              toolCallId: String(block.tool_use_id),
              name: '', // filled by the session from its in-flight map
              outputPreview: previewOf(block.content),
              isError: Boolean(block.is_error)
            })
          )
        }
      }
      return out
    }

    case 'result':
      return [
        makeEvent(ctx, 'turn.completed', {
          status: msg.is_error ? 'error' : 'success',
          inputTokens: msg.usage?.input_tokens ?? null,
          outputTokens: msg.usage?.output_tokens ?? null,
          costUsd: msg.total_cost_usd ?? null,
          durationMs: msg.duration_ms ?? null
        })
      ]

    default:
      return []
  }
}
