import type { AssetReviewState, SkillAssetTier } from './skillAssets'

export type Risk = 'LOW' | 'MEDIUM' | 'HIGH'

/**
 * A shell command about to run a file that lives inside a skill (spec §7.2/§7.3).
 *
 * `verdict.reason` never reaches the approval card, so everything the card must say about the
 * script travels here. The body is capped with explicit byte counts rather than an inline
 * truncation marker: a marker gets re-truncated downstream and misread, which is why PTC
 * returns structured byte fields (`ptc/run.ts`).
 */
export interface SkillAssetContext {
  skill: string
  tier: SkillAssetTier
  /** POSIX-separated, relative to the skill directory. */
  relPath: string
  /** sha256 of the bytes about to run; leads the verdict's grant key. */
  hash: string
  /**
   * sha256 of the whitespace-normalised shell segment the script was found in — the second half
   * of the grant key, so a session approval covers `sh collect.sh` and not `sh collect.sh
   * --purge /`. A digest, never content: it crosses to the renderer on `request.opened` like
   * the rest of this object, and the card has no use for it.
   */
  segmentKey: string
  reviewState: AssetReviewState
  /** The bytes about to run, capped to `SKILL_ASSET_BODY_CAP`. */
  body: string
  bodyBytesTotal: number
  bodyBytesOmitted: number
}

export interface AgentEventBase {
  eventId: string
  caseId: number
  caseSlug: string
  sessionId: number
  turnId: number | null
  ts: string // ISO 8601
}

export type AgentEvent = AgentEventBase &
  (
    | {
        type: 'session.started'
        payload: {
          model: string
          resumed: boolean
          // The permission mode the CLI actually adopted for this session, straight from
          // its own system/init message — NOT an echo of what Argus requested. Only the
          // Claude driver reports it today; every other driver (and every session.started
          // written before this field existed) has NOTHING to say about it here, and that
          // silence is spelled `null`, never omitted. A future comparison against the
          // requested mode treats a MISMATCH as a refusal signal — so `null` must stay
          // unambiguously "no report", not something that reads as a refusal itself.
          effectivePermissionMode: string | null
        }
      }
    | {
        type: 'session.exited'
        payload: { reason: 'stopped' | 'reaped' | 'crashed' | 'reconfigured' }
      }
    | { type: 'session.error'; payload: { message: string; raw?: unknown } }
    | {
        type: 'turn.started'
        // composed is set only for Argus-composed turns (review run, apply, CI analyze
        // prompts) so the renderer can markdown-render them; typed turns omit it entirely
        // (not `false`) so pre-Part-3 mirrored events — which lack the field — replay as
        // falsy and keep rendering plain, with zero schema migration.
        payload: { userText: string; composed?: boolean }
      }
    | {
        type: 'turn.completed'
        payload: {
          status: 'success' | 'error' | 'interrupted'
          inputTokens: number | null
          outputTokens: number | null
          costUsd: number | null
          durationMs: number | null
        }
      }
    | {
        // How full the model's context window is RIGHT NOW — deliberately not derivable from
        // turn.completed, whose token counts are per-turn totals summed over every API call in
        // the turn and so grow without bound while the live context stays flat (and drops on a
        // compaction). Both fields are nullable because they arrive from different messages:
        // the size of the context comes from the assistant turn that was just billed, the size
        // of the WINDOW only from the end-of-turn result. Consumers keep the last non-null of
        // each rather than treating a null as "unknown now".
        type: 'context.usage'
        payload: { usedTokens: number | null; contextWindow: number | null }
      }
    | { type: 'content.delta'; payload: { text: string } }
    | { type: 'assistant.message'; payload: { text: string } } // finalized text of the block(s)
    | { type: 'tool.call.started'; payload: { toolCallId: string; name: string } }
    | {
        type: 'tool.call.completed'
        payload: { toolCallId: string; name: string; outputPreview: string; isError: boolean }
      }
    | {
        type: 'request.opened'
        payload: {
          requestId: string
          tool: string
          risk: Risk
          grantKey: string | null
          argsPreview: string // human-readable rendering of the args
          input?: Record<string, unknown> // full args (asks only; absent in pre-Part-3 mirrors)
          /** Present only for a shell ask that resolved to a skill asset. Carries a script body,
           *  so `forMirror` strips it alongside `input` — it must never reach the on-disk
           *  mirror, which `IPC.agentHistory` replays straight back to the renderer. */
          assetContext?: SkillAssetContext
        }
      }
    | {
        type: 'request.resolved'
        payload: { requestId: string; decision: 'allow' | 'allow-session' | 'deny' | 'cancelled' }
      }
    | { type: 'case.finding.added'; payload: { markdown: string } }
    | { type: 'case.finding.updated'; payload: { findingId: number } }
    | { type: 'case.evidence.ingested'; payload: { evidenceId: number; relPath: string } }
    | { type: 'session.mcp.skipped'; payload: { instanceId: string; reason: string } }
    | {
        type: 'dialog.opened'
        payload: {
          dialogId: string
          questions: Array<{
            question: string
            header: string
            multiSelect: boolean
            options: Array<{ label: string; description: string }>
          }>
        }
      }
    | {
        type: 'dialog.resolved'
        payload: { dialogId: string; behavior: 'completed' | 'cancelled' }
      }
  )
