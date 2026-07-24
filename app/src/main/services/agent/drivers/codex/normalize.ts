import type { AgentEvent } from '../../../../../shared/agent-events'
import { makeEvent, type NormalizeCtx } from '../../events'
import type { TurnResult } from '../../driver'

const PREVIEW_MAX = 2000

/** A raw Codex `app-server` inbound notification: `client.onNotification(...)` payloads
 *  are `{ method, params }` (no `id` — see wire contract §1/§2). */
export interface RawCodexNotification {
  method: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any
}

function previewOf(content: unknown): string {
  const s = typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content)
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '…' : s
}

interface CodexUsage {
  inputTokens: number | null
  outputTokens: number | null
}

function emptyUsage(): CodexUsage {
  return { inputTokens: null, outputTokens: null }
}

/** `turn.status` (contract §5) mapped onto the smaller vocabulary this normalizer's
 *  `turnBoundary` exposes. Codex genuinely distinguishes a failed turn from an
 *  interrupted one on the wire (`"completed" | "interrupted" | "failed" | "inProgress"`),
 *  so — unlike `CopilotNormalizer`, whose wire never surfaces a distinct turn-level
 *  failure — this union adds `'error'`. `turn.completed`'s own AgentEvent payload
 *  already supports a `'error'` status value, so this isn't widening anything, just
 *  using the status the type already allows (see plan/brief mapping: 'failed' → 'error').
 */
type CodexTurnBoundary = 'success' | 'interrupted' | 'error'

function mapTurnStatus(status: unknown): CodexTurnBoundary {
  if (status === 'completed') return 'success'
  if (status === 'interrupted') return 'interrupted'
  // 'failed' and anything unrecognized (e.g. a stray 'inProgress' on a completed
  // notification) fail closed to 'error' rather than silently reporting success.
  return 'error'
}

export interface CodexNormalizer {
  /** Map one raw app-server notification to zero or more AgentEvents (also folds
   *  per-turn accounting state: accumulated item text, cached token usage). */
  normalize(raw: RawCodexNotification, ctx: NormalizeCtx): AgentEvent[]
  /**
   * Non-null when `raw` is `turn/completed` — the SOLE turn boundary on this wire
   * (contract §6; every `item/started`/`item/completed` in between is a sub-step, never
   * a boundary). As a side effect, caches this turn's status/duration so the immediately
   * following `turnResult()` call reflects them — mirroring the copilot driver's call
   * order (`turnBoundary(raw)` → `turnResult()` → `normalize(raw, ctx)`, same `raw`).
   */
  turnBoundary(raw: RawCodexNotification): CodexTurnBoundary | null
  /** Snapshot accounting for `onTurnResult`; call just after `turnBoundary` returns
   *  non-null for the same raw, before yielding `turn.completed`. */
  turnResult(): TurnResult
  /**
   * Always null: the Codex wire has no typed auth-failure notification (contract §9 —
   * explicitly `NOT FOUND IN SOURCE`, only the steady-state `requiresOpenaiAuth` flag on
   * `account/read`/`getAuthStatus` results, not an in-turn error shape). Auth is verified
   * out-of-band via `probeAuth`, not per-notification here. Kept as a method (rather than
   * omitted) solely to match `CopilotNormalizer`'s shape for Task 6.
   */
  authErrorResult(raw: RawCodexNotification): TurnResult | null
}

/**
 * Stateful normalizer for a single Codex `app-server` session/thread. Token usage lands
 * on its own `thread/tokenUsage/updated` notification strictly before `turn/completed`
 * (contract §7); this factory caches the latest `tokenUsage.last` (the just-completed
 * turn's own tokens, not the thread-cumulative `total`) so `turn.completed` and
 * `onTurnResult` can both attach it. There is no cost figure anywhere on this wire
 * (contract §7: zero matches for "cost" in the generated schema) — `costUsd` is always
 * null, never computed.
 */
export function createCodexNormalizer(init: { resumed: boolean; model: string }): CodexNormalizer {
  const model = init.model
  let usage: CodexUsage = emptyUsage()
  let lastBoundary: CodexTurnBoundary | null = null
  let lastDurationMs: number | null = null

  // Per-item accumulation, keyed by itemId. Defensive fallbacks only: `item/completed`
  // already carries the full text (`agentMessage`) / aggregated output
  // (`commandExecution`) / changes (`fileChange`) per contract §5, so these are consulted
  // only when that field is missing, not the primary source of the finalized event.
  const messageAccum = new Map<string, string>()
  const outputAccum = new Map<string, string>()
  const patchAccum = new Map<string, Array<{ path: string; diff: string; kind: unknown }>>()

  function normalize(raw: RawCodexNotification, ctx: NormalizeCtx): AgentEvent[] {
    if (!raw || typeof raw.method !== 'string') return []
    const p = raw.params ?? {}

    switch (raw.method) {
      // New turn — reset per-turn usage accounting (mirrors copilot's assistant.turn_start).
      case 'turn/started':
        usage = emptyUsage()
        return []

      case 'item/agentMessage/delta': {
        const delta = p.delta
        if (typeof delta !== 'string') return []
        const itemId = String(p.itemId ?? '')
        if (itemId) messageAccum.set(itemId, (messageAccum.get(itemId) ?? '') + delta)
        return [makeEvent(ctx, 'content.delta', { text: delta })]
      }

      case 'item/commandExecution/outputDelta': {
        const delta = p.delta
        const itemId = String(p.itemId ?? '')
        if (itemId && typeof delta === 'string') {
          outputAccum.set(itemId, (outputAccum.get(itemId) ?? '') + delta)
        }
        return []
      }

      case 'item/fileChange/patchUpdated': {
        const itemId = String(p.itemId ?? '')
        const changes = p.changes
        if (itemId && Array.isArray(changes)) {
          patchAccum.set(itemId, [...(patchAccum.get(itemId) ?? []), ...changes])
        }
        return []
      }

      case 'item/started': {
        const item = p.item ?? {}
        const itemId = String(item.id ?? '')
        if (item.type === 'commandExecution') {
          return [makeEvent(ctx, 'tool.call.started', { toolCallId: itemId, name: 'shell' })]
        }
        if (item.type === 'fileChange') {
          return [makeEvent(ctx, 'tool.call.started', { toolCallId: itemId, name: 'write' })]
        }
        // agentMessage / reasoning / other item kinds carry no useful start signal.
        return []
      }

      case 'item/completed': {
        const item = p.item ?? {}
        const itemId = String(item.id ?? '')

        if (item.type === 'agentMessage') {
          const text = typeof item.text === 'string' ? item.text : (messageAccum.get(itemId) ?? '')
          messageAccum.delete(itemId)
          return text ? [makeEvent(ctx, 'assistant.message', { text })] : []
        }

        if (item.type === 'commandExecution') {
          const output =
            typeof item.aggregatedOutput === 'string'
              ? item.aggregatedOutput
              : (outputAccum.get(itemId) ?? '')
          outputAccum.delete(itemId)
          const exitCode = item.exitCode
          const status = item.status
          const isError =
            (exitCode !== null && exitCode !== undefined && exitCode !== 0) ||
            status === 'failed' ||
            status === 'declined'
          return [
            makeEvent(ctx, 'tool.call.completed', {
              toolCallId: itemId,
              name: 'shell',
              outputPreview: previewOf(output),
              isError
            })
          ]
        }

        if (item.type === 'fileChange') {
          const changes = Array.isArray(item.changes)
            ? item.changes
            : (patchAccum.get(itemId) ?? [])
          patchAccum.delete(itemId)
          const status = item.status
          const isError = status === 'failed' || status === 'declined'
          return [
            makeEvent(ctx, 'tool.call.completed', {
              toolCallId: itemId,
              name: 'write',
              outputPreview: previewOf(changes),
              isError
            })
          ]
        }

        // Any other item type (plan items, dynamic tool calls, etc.) — no v1 mapping yet.
        return []
      }

      // No reasoning event exists in AgentEvent v1 — drop, per the brief/plan (log-and-ignore).
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
        return []

      case 'thread/tokenUsage/updated': {
        const last = p.tokenUsage?.last
        if (last) {
          usage = {
            inputTokens: typeof last.inputTokens === 'number' ? last.inputTokens : null,
            outputTokens: typeof last.outputTokens === 'number' ? last.outputTokens : null
          }
        }
        return []
      }

      case 'turn/completed': {
        const turn = p.turn ?? {}
        return [
          makeEvent(ctx, 'turn.completed', {
            status: mapTurnStatus(turn.status),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: null, // no cost field anywhere on this wire (contract §7) — never fabricated
            durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : null
          })
        ]
      }

      case 'error': {
        // `willRetry:true` is a transient warning (mirrors CodexAdapter's runtime.warning
        // vs runtime.error split, contract §9) — AgentEvent v1 has no warning event, so
        // it's dropped, matching how reasoning deltas are dropped for the same reason.
        if (p.willRetry) return []
        return [
          makeEvent(ctx, 'session.error', {
            message: String(p.error?.message ?? 'Codex session error'),
            raw: p.error
          })
        ]
      }

      default:
        // Unknown/unhandled method (thread/started, turn/steer acks, thread/rollback,
        // account/* server requests routed elsewhere, etc.) — log-and-ignore.
        return []
    }
  }

  function turnBoundary(raw: RawCodexNotification): CodexTurnBoundary | null {
    if (!raw || raw.method !== 'turn/completed') return null
    const turn = raw.params?.turn ?? {}
    const mapped = mapTurnStatus(turn.status)
    lastBoundary = mapped
    lastDurationMs = typeof turn.durationMs === 'number' ? turn.durationMs : null
    return mapped
  }

  function turnResult(): TurnResult {
    return {
      isError: lastBoundary === 'error',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: null,
      durationMs: lastDurationMs,
      model,
      authFailure: false
    }
  }

  // No `raw` parameter needed here — see the CodexNormalizer JSDoc: always null, since
  // the wire has no typed auth-failure notification to inspect (a function with fewer
  // parameters than its declared type still satisfies that type).
  function authErrorResult(): TurnResult | null {
    return null
  }

  return { normalize, turnBoundary, turnResult, authErrorResult }
}
