/**
 * Stable per-session seed; every sink derives the session's trace id from it alone.
 *
 * Scoped to the INSTALL: session row ids start at 1 in every Argus home, so a backend shared by
 * several installs (the roadmap's one company-wide Langfuse) merged two installs' "session 1"
 * into one trace (seen live 2026-10-25: a July session and a smoke session under one trace id,
 * 2161 h of "latency", scores attached to the wrong install's work). Same `<id>@<qualifier>`
 * shape as `distillJobSeed`. The install id is created the moment a provider is enabled
 * (`readOrCreateInstanceId`), so an empty one here is a wiring bug — refuse rather than fall
 * back to the colliding legacy form.
 *
 * Deliberate break: a session that already has a trace under the pre-fix seed starts a new
 * trace after the upgrade (the sinks cache roots per seed; nothing re-parents).
 */
export function seedFor(installId: string, sessionId: number): string {
  if (!installId)
    throw new Error('seedFor: install id is required (session seeds are install-scoped)')
  return `argus-session-${sessionId}@${installId}`
}

export interface TraceRootIntent {
  kind: 'trace-root'
  seed: string
  name: string
  /** Argus case this session belongs to. The sink maps this onto the Langfuse session. */
  caseSlug: string
  metadata: Record<string, unknown>
}

export interface GenerationIntent {
  kind: 'generation'
  seed: string
  name: string
  model: string
  /** Epoch ms. Omitted when the source event carried an unparseable timestamp. */
  startTime?: number
  endTime?: number
  usage?: { input?: number; output?: number }
  costUsd?: number
  input?: string
  output?: string
}

export interface ToolIntent {
  kind: 'tool'
  seed: string
  name: string
  startTime?: number
  endTime?: number
  isError: boolean
  output?: string
}

export interface EventIntent {
  kind: 'event'
  seed: string
  name: string
  level?: 'DEFAULT' | 'ERROR'
  metadata?: Record<string, unknown>
}

export interface ScoreIntent {
  kind: 'score'
  seed: string
  name: string
  value: number
  comment?: string
  /** Free-form score metadata (Langfuse `ScoreBody.metadata`). */
  metadata?: Record<string, unknown>
  /** Explicit score id (Langfuse `CreateScoreRequest.id`): a deterministic id makes a re-emit
   *  of the same fact an upsert instead of a second score. Absent → the server assigns one. */
  id?: string
}

export type ObservationIntent =
  TraceRootIntent | GenerationIntent | ToolIntent | EventIntent | ScoreIntent
