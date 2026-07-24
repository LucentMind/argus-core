import type { AgentEvent } from '../../../../../shared/agent-events'
import { makeEvent, type NormalizeCtx } from '../../events'
import type { TurnResult } from '../../driver'

const PREVIEW_MAX = 2000

/**
 * Mirrors `copilot/normalize.ts`'s `previewOf` helper: stringify a rendered value into a
 * human-readable, length-capped preview. Used as the fallback when a `tool_call_update`'s
 * `content` blocks don't yield any extractable text — `rawOutput` is a plain object per the
 * real ACP schema, so `String(rawOutput)` alone would render the useless `"[object Object]"`.
 */
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

/**
 * Extract human-readable text out of ACP `ToolCallContent[]` blocks (schema.d.ts:43-143).
 * The `content` variant wraps a `ContentBlock`; only its `text` sub-variant renders to plain
 * text here (image/audio/resource blocks carry no text to preview). The `diff` variant
 * carries a file `path` + `newText` directly (no nested ContentBlock). `terminal` blocks
 * (just a `terminalId`) contribute nothing. Returns null when no block yields text, so the
 * caller falls back to `previewOf(rawOutput)`.
 */
function previewFromToolCallContent(blocks: unknown): string | null {
  if (!Array.isArray(blocks) || blocks.length === 0) return null
  const parts: string[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'content' && b.content && typeof b.content === 'object') {
      const inner = b.content as Record<string, unknown>
      if (inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
    } else if (b.type === 'diff' && typeof b.newText === 'string') {
      parts.push(typeof b.path === 'string' ? `${b.path}:\n${b.newText}` : b.newText)
    }
  }
  if (parts.length === 0) return null
  const s = parts.join('\n')
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

export interface AcpNormalizer {
  /** Map one flat `session/update` sub-object (`params.update`, discriminated by
   *  `sessionUpdate`) to zero or more AgentEvents. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  normalize(update: any, ctx: NormalizeCtx): AgentEvent[]
  /** Non-null when `update` is a turn boundary; the status its `turn.completed` will carry. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  turnBoundary(update: any): 'success' | 'interrupted' | null
  /** Snapshot accounting for `onTurnResult`; call just before yielding `turn.completed`. */
  turnResult(): TurnResult
  /** Auth-failure TurnResult when `update` is a typed auth error; else null. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authErrorResult(update: any): TurnResult | null
}

/**
 * Stateful normalizer for a single ACP (Cursor/Grok) session. Real `session/update` has 8
 * variants (EVIDENCE.md §4), not the 5 the design doc originally assumed:
 * `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` / `tool_call` /
 * `tool_call_update` / `plan` / `available_commands_update` / `current_mode_update`. The 3
 * extras are intentional no-ops here, each with an explicit case so a future reader sees
 * they were considered rather than overlooked.
 */
export function createAcpNormalizer(init: { resumed: boolean; model: string }): AcpNormalizer {
  // Neither is ever reassigned: unlike Copilot's SDK events, no real ACP `session/update`
  // variant (EVIDENCE.md §4) carries a resolved model or usage accounting — model comes from
  // `init` only, and usage stays permanently empty (costReporting: false for this driver).
  const model = init.model
  const usage = emptyAccounting()
  const toolNames = new Map<string, string>() // toolCallId → title/kind

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function normalize(u: any, ctx: NormalizeCtx): AgentEvent[] {
    switch (u?.sessionUpdate) {
      // Echo of the user's own prompt text streamed back by the agent — intentional no-op.
      case 'user_message_chunk':
        return []

      case 'agent_message_chunk': {
        const content = u.content
        if (content?.type !== 'text') return [] // non-text ContentBlock (image/audio/…): no delta
        const text = content.text
        return typeof text === 'string' && text.length > 0
          ? [makeEvent(ctx, 'content.delta', { text })]
          : []
      }

      // Agent's internal reasoning/scratchpad — not surfaced as a case-log event.
      case 'agent_thought_chunk':
        return []

      case 'tool_call': {
        const id = String(u.toolCallId ?? '')
        const name = String(u.title ?? u.kind ?? '')
        if (id) toolNames.set(id, name)
        return [makeEvent(ctx, 'tool.call.started', { toolCallId: id, name })]
      }

      case 'tool_call_update': {
        if (u.status !== 'completed' && u.status !== 'failed') return []
        const id = String(u.toolCallId ?? '')
        const preview = previewFromToolCallContent(u.content) ?? previewOf(u.rawOutput)
        return [
          makeEvent(ctx, 'tool.call.completed', {
            toolCallId: id,
            name: toolNames.get(id) ?? String(u.title ?? ''),
            outputPreview: preview,
            isError: u.status === 'failed'
          })
        ]
      }

      // Folded into the exit-plan approval flow (Task 6, index.ts) — not an AgentEvent here.
      case 'plan':
        return []

      // Command-palette metadata — no case-log equivalent; intentional no-op.
      case 'available_commands_update':
        return []

      // Session mode-switch bookkeeping — no case-log equivalent; intentional no-op.
      case 'current_mode_update':
        return []

      default:
        return []
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function turnBoundary(u: any): 'success' | 'interrupted' | null {
    if (u?.stopReason === 'end_turn' || u?.type === 'turn.completed') return 'success'
    if (u?.stopReason === 'cancelled') return 'interrupted'
    return null
  }

  function turnResult(): TurnResult {
    return { isError: false, ...usage, costUsd: null, model, authFailure: false }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function authErrorResult(u: any): TurnResult | null {
    if (u?.type !== 'error') return null
    const msg = String(u.message ?? '')
    if (!/auth|unauthorized|api key/i.test(msg)) return null
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
