import type { AgentEvent } from '../../../../../shared/agent-events'
import { makeEvent, type NormalizeCtx } from '../../events'

const PREVIEW_MAX = 2000

function previewOf(content: unknown): string {
  const s =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((b) =>
              typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : ''
            )
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
        return [
          // `resumed` is a placeholder — corrected by the driver, which owns the cursor.
          // NormalizeCtx carries no resume cursor, so this cannot be decided here.
          makeEvent(ctx, 'session.started', { model: String(msg.model ?? ''), resumed: false })
        ]
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
      const content = msg.message?.content ?? []
      const out: AgentEvent[] = []

      const text = content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('')
      if (text) out.push(makeEvent(ctx, 'assistant.message', { text }))

      // A sub-agent's tool calls NEVER arrive as `stream_event` partials — they appear
      // only here, in finished assistant messages tagged with `parent_tool_use_id`.
      // Captured live from the SDK; see __fixtures__/EVIDENCE.md. Without this their
      // starts are lost, and the matching completions reach Langfuse with no name and
      // no duration ("Unnamed tool", zero length).
      //
      // Gated on `parent_tool_use_id` deliberately: a TOP-LEVEL tool_use arrives twice
      // — once as a stream_event partial, once in the finished message, same id — so
      // emitting for those here would produce a second start and overwrite the real,
      // earlier start time, shortening the tool's measured duration. Top-level starts
      // therefore stay the stream path's job, which depends on includePartialMessages
      // remaining on (guarded by a test in __tests__/claudeDriver.test.ts).
      if (msg.parent_tool_use_id) {
        for (const block of content) {
          if (block?.type === 'tool_use') {
            out.push(
              makeEvent(ctx, 'tool.call.started', {
                toolCallId: String(block.id),
                name: String(block.name)
              })
            )
          }
        }
      }

      // Live context size, emitted last so the transcript-bearing events keep their order.
      // `message.usage` here is ONE API call's usage, which is exactly what fills the window:
      // the prompt (fresh + cache-created + cache-read) plus what was just written. The result
      // message's `usage` cannot be used for this — it is the turn's total across every API
      // call, so a 30-tool turn would report many times the real context.
      //
      // Sub-agent messages (parent_tool_use_id set) are billed against their OWN window, not
      // the main thread's, so they must not overwrite it.
      const usage = msg.message?.usage
      if (usage && !msg.parent_tool_use_id) {
        const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
        out.push(
          makeEvent(ctx, 'context.usage', {
            usedTokens:
              n(usage.input_tokens) +
              n(usage.cache_read_input_tokens) +
              n(usage.cache_creation_input_tokens) +
              n(usage.output_tokens),
            contextWindow: null
          })
        )
      }

      return out
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

    case 'result': {
      const out: AgentEvent[] = [
        makeEvent(ctx, 'turn.completed', {
          status: msg.is_error ? 'error' : 'success',
          inputTokens: msg.usage?.input_tokens ?? null,
          outputTokens: msg.usage?.output_tokens ?? null,
          costUsd: msg.total_cost_usd ?? null,
          durationMs: msg.duration_ms ?? null
        })
      ]
      // `modelUsage` is the only place the SDK states the window size. Unlike its sibling
      // token counts it is a static property of the model, not an accumulator, so reading it
      // off a turn total is sound. A turn that fell back across models reports one entry each;
      // take the largest, since that is the window the live thread is running in.
      const windows = Object.values(msg.modelUsage ?? {})
        .map((m) => (m as { contextWindow?: unknown }).contextWindow)
        .filter((w): w is number => typeof w === 'number' && w > 0)
      if (windows.length > 0) {
        out.push(
          makeEvent(ctx, 'context.usage', {
            usedTokens: null,
            contextWindow: Math.max(...windows)
          })
        )
      }
      return out
    }

    default:
      return []
  }
}
