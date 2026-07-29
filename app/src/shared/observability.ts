import type { ReviewLayerId, ReviewSeverity } from './reviewLayers'
import type { ModeId } from './modes'

export interface ModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface MetricsSummary {
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  byModel: ModelUsage[]
  turns: { total: number; error: number }
  tools: {
    total: number
    denied: number
    byDecision: Record<string, number>
    byRisk: Record<string, number>
  }
  findings: { total: number; accepted: number; rejected: number; pending: number }
  latencyMs: { turnP50: number | null; turnP95: number | null }
}

export interface GlobalMetrics extends MetricsSummary {
  resolvedCases: number
  costPerResolvedCaseUsd: number | null
}

export interface MetricsQuery {
  since?: string // ISO lower-bound on created_at
}

export interface LangfuseConfig {
  enabled: boolean
  host: string
  publicKey: string
  captureContent: boolean
}

export type ReviewState = 'pending' | 'accepted' | 'rejected'

export interface FindingRow {
  id: number
  caseId: number
  sessionId: number | null
  turnId: number | null
  summary: string
  reviewState: ReviewState
  reviewedAt: string | null
  createdAt: string
  /** Finding body markdown (from findings.md, joined by id marker). Absent for
   *  legacy findings written before markers existed. */
  body?: string
  /** Review flavor; null on investigation findings. */
  layer: ReviewLayerId | null
  severity: ReviewSeverity | null
  /** Anchor parsed from the finding's first citation at write time. */
  diffPath: string | null
  diffLine: number | null
  /** The fix the review agent proposed, if any. Gates the Apply action. */
  suggestedChange: string | null
  /** Set once this finding has been posted as a PR comment; the comment's html url. */
  commentUrl: string | null
  /** Set once this finding's change has been pushed; the commit sha that landed. */
  pushedSha: string | null
  /** Author-facing comment prose written at record time (Plan 6 §1); null on older findings. */
  commentBody: string | null
  /** PR head sha the finding was recorded against (Plan 6 staleness); null when unknown. */
  headSha: string | null
  /** Derived from the finding's session (sessions.mode), never stored on the row.
   *  A finding with no session reads as the default mode. */
  mode: ModeId
}

export interface SkillUsageRow {
  name: string
  /** null = activations recorded for a name no longer resolved (skill deleted/renamed) —
   *  reported rather than silently dropped. Tier reflects CURRENT resolution (spec §2 caveat). */
  tier: 'bundled' | 'user' | 'hivemind' | null
  enabled: boolean
  activationCount: number
  lastActivatedAt: string | null
}
export interface MemoryUsageRow {
  topic: string
  recallCount: number
  lastRecalledAt: string | null
  lastWrittenAt: string | null
  staleCandidate: boolean
}
export interface ReferenceUsageRow {
  relPath: string
  readCount: number
  lastReadAt: string | null
}
export interface ArchivedTopicRow {
  topic: string
  archivedAt: string | null
  sizeBytes: number
}
export interface UsageStatsPayload {
  hygiene: { staleDays: number; minRecalls: number; trackingStartedAt: string }
  skills: SkillUsageRow[]
  memory: MemoryUsageRow[]
  references: ReferenceUsageRow[]
  archived: ArchivedTopicRow[]
}
