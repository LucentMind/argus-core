import type { AgentEvent } from '../../../../../shared/agent-events'
import { makeEvent, type NormalizeCtx } from '../../events'
import type { TurnResult } from '../../driver'

const PREVIEW_MAX = 2000

/** A raw Copilot SDK session event: `session.on(...)` payloads are `{ type, data }`. */
export interface RawSdkEvent {
  type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
}

/** The typed message substring the SDK leaks on an unauthenticated turn (EVIDENCE §7). */
export const COPILOT_AUTH_ERROR_SUBSTRING = 'Session was not created with authentication info'

function previewOf(content: unknown): string {
  const s =
    typeof content === 'string'
      ? content
      : content === null || content === undefined
        ? ''
        : typeof content === 'object' && content && 'content' in content
          ? String((content as { content: unknown }).content)
          : JSON.stringify(content)
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '…' : s
}

interface TurnAccounting {
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number | null
}

function emptyAccounting(): TurnAccounting {
  return { inputTokens: null, outputTokens: null, durationMs: null }
}

export interface CopilotNormalizer {
  /** Map one raw SDK event to zero or more AgentEvents (also folds accounting state). */
  normalize(raw: RawSdkEvent, ctx: NormalizeCtx): AgentEvent[]
  /** Non-null when `raw` is a turn boundary; the status its `turn.completed` will carry. */
  turnBoundary(raw: RawSdkEvent): 'success' | 'interrupted' | null
  /** Snapshot accounting for `onTurnResult`; call just before yielding `turn.completed`. */
  turnResult(): TurnResult
  /** Auth-failure TurnResult when `raw` is a typed authentication `session.error`; else null. */
  authErrorResult(raw: RawSdkEvent): TurnResult | null
}

/**
 * Stateful normalizer for a single Copilot session. Unlike the Claude driver (whose
 * `result` message carries the whole turn), Copilot splits the turn across events:
 * usage lands on `assistant.usage`, the boundary on `assistant.turn_end`. This factory
 * closes over the per-turn accounting so `turn.completed` and `onTurnResult` agree, and
 * tracks the RESOLVED model (from `turn_start`/`usage`/`auto_mode_resolved`), not `"auto"`.
 */
export function createCopilotNormalizer(init: {
  resumed: boolean
  model: string
}): CopilotNormalizer {
  let model = init.model
  let usage = emptyAccounting()
  const toolNames = new Map<string, string>() // toolCallId → toolName

  function normalize(raw: RawSdkEvent, ctx: NormalizeCtx): AgentEvent[] {
    if (!raw || typeof raw !== 'object') return []
    const d = raw.data ?? {}

    switch (raw.type) {
      case 'session.start':
        return [makeEvent(ctx, 'session.started', { model, resumed: init.resumed })]
      case 'session.resume':
        return [makeEvent(ctx, 'session.started', { model, resumed: true })]

      // Router / model plumbing — carries the resolved model; update state, emit nothing.
      case 'session.model_change':
        if (d.newModel) model = String(d.newModel)
        return []
      case 'session.auto_mode_resolved':
        if (d.chosenModel) model = String(d.chosenModel)
        return []

      case 'assistant.turn_start':
        if (d.model) model = String(d.model)
        usage = emptyAccounting() // reset accounting for the new turn
        return []

      // The streamed text delta is `message_delta.deltaContent`; `streaming_delta` carries
      // only a byte counter (no text) and `reasoning*` are opaque — ignore both.
      case 'assistant.message_delta': {
        const text = d.deltaContent
        return text ? [makeEvent(ctx, 'content.delta', { text: String(text) })] : []
      }

      case 'assistant.message': {
        const text = d.content
        return text ? [makeEvent(ctx, 'assistant.message', { text: String(text) })] : []
      }

      case 'assistant.usage':
        if (d.model) model = String(d.model)
        usage = {
          inputTokens: typeof d.inputTokens === 'number' ? d.inputTokens : null,
          outputTokens: typeof d.outputTokens === 'number' ? d.outputTokens : null,
          durationMs: typeof d.duration === 'number' ? d.duration : null
        }
        return []

      case 'assistant.turn_end':
        return [
          makeEvent(ctx, 'turn.completed', {
            status: 'success',
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: null, // costReporting: false — always null (plan amendment 10)
            durationMs: usage.durationMs
          })
        ]

      case 'abort':
        return [
          makeEvent(ctx, 'turn.completed', {
            status: 'interrupted',
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: null,
            durationMs: usage.durationMs
          })
        ]

      case 'tool.execution_start': {
        const id = String(d.toolCallId ?? '')
        const name = String(d.toolName ?? '')
        if (id) toolNames.set(id, name)
        return [makeEvent(ctx, 'tool.call.started', { toolCallId: id, name })]
      }

      case 'tool.execution_complete': {
        const id = String(d.toolCallId ?? '')
        return [
          makeEvent(ctx, 'tool.call.completed', {
            toolCallId: id,
            name: toolNames.get(id) ?? String(d.toolName ?? ''),
            outputPreview: previewOf(d.result ?? d.error),
            isError: d.success === false
          })
        ]
      }

      case 'session.error':
        return [
          makeEvent(ctx, 'session.error', {
            message: String(d.message ?? 'Copilot session error'),
            raw: d
          })
        ]

      default:
        return []
    }
  }

  function turnBoundary(raw: RawSdkEvent): 'success' | 'interrupted' | null {
    if (raw?.type === 'assistant.turn_end') return 'success'
    if (raw?.type === 'abort') return 'interrupted'
    return null
  }

  function turnResult(): TurnResult {
    // Neither a successful nor an interrupted turn is an *error* (an interrupt is a user
    // action, not a failure); auth failures come through authErrorResult instead.
    return {
      isError: false,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: null,
      durationMs: usage.durationMs,
      model,
      authFailure: false
    }
  }

  function authErrorResult(raw: RawSdkEvent): TurnResult | null {
    if (raw?.type !== 'session.error') return null
    const d = raw.data ?? {}
    const isAuth =
      d.errorType === 'authentication' ||
      String(d.message ?? '').includes(COPILOT_AUTH_ERROR_SUBSTRING)
    if (!isAuth) return null
    return {
      isError: true,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      durationMs: null,
      model,
      authFailure: true
    }
  }

  return { normalize, turnBoundary, turnResult, authErrorResult }
}
