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
