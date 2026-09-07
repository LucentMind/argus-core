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
          //
          // `permissionMode` is the mode the CLI actually adopted (verified against SDK
          // 0.3.220's real init message — values like 'default' | 'acceptEdits' | 'plan' |
          // 'bypassPermissions' | 'auto'), which can silently differ from what Argus
          // requested when org policy blocks the requested mode. Missing → null, which
          // means "nothing reported", not a refusal.
          makeEvent(ctx, 'session.started', {
            model: String(msg.model ?? ''),
            resumed: false,
            effectivePermissionMode:
              typeof msg.permissionMode === 'string' ? msg.permissionMode : null
          })
        ]
      }
      // Compaction lifecycle, as SDK 0.3.220 really emits it (captured 2026-09-07): a
      // `status: 'compacting'` first, then `status: null` carrying `compact_result`
      // ('success' | 'failed', with `compact_error` on failure), then — on success only — a
      // `compact_boundary` with the token figures. No assistant message accompanies any of
      // these, so without this branch the UI showed nothing for the whole ~14s and kept the
      // pre-compact gauge afterwards.
      if (msg.subtype === 'status') {
        if (msg.status === 'compacting') {
          return [
            makeEvent(ctx, 'session.notice', { kind: 'compacting', text: 'Compacting context…' })
          ]
        }
        if (msg.compact_result === 'failed') {
          const why = typeof msg.compact_error === 'string' ? msg.compact_error : 'unknown error'
          return [
            makeEvent(ctx, 'session.notice', {
              kind: 'compact_failed',
              text: `Compaction failed: ${why}`
            })
          ]
        }
        return []
      }
      if (msg.subtype === 'compact_boundary') {
        const meta = msg.compact_metadata ?? {}
        const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
        const preTokens = num(meta.pre_tokens)
        const postTokens = num(meta.post_tokens)
        const trigger: 'manual' | 'auto' = meta.trigger === 'auto' ? 'auto' : 'manual'
        const text =
          preTokens !== null
            ? `Context compacted — ${preTokens.toLocaleString('en-US')} tokens summarized`
            : 'Context compacted'
        return [
          makeEvent(ctx, 'session.notice', { kind: 'compacted', text }),
          makeEvent(ctx, 'context.compacted', { trigger, preTokens, postTokens })
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
      //
      // Synthetic replies (`model: '<synthetic>'` — what `/context`, and a `/compact` that
      // found nothing to compact, answer with; captured 2026-09-07) made no API call, and
      // their usage is all zeros. Summing that reported "0% of the window" the moment a user
      // typed a slash command. The zero-sum guard also covers any other bookkeeping message:
      // a real API call is never free.
      const usage = msg.message?.usage
      if (usage && !msg.parent_tool_use_id && msg.message?.model !== '<synthetic>') {
        const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
        const usedTokens =
          n(usage.input_tokens) +
          n(usage.cache_read_input_tokens) +
          n(usage.cache_creation_input_tokens) +
          n(usage.output_tokens)
        if (usedTokens > 0) {
          out.push(makeEvent(ctx, 'context.usage', { usedTokens, contextWindow: null }))
        }
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
