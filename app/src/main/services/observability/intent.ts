/** Stable per-session seed. Deterministically derives the Langfuse trace id. */
export function seedFor(sessionId: number): string {
  return `argus-session-${sessionId}`
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
