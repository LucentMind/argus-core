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
  tools: { total: number; denied: number; byDecision: Record<string, number>; byRisk: Record<string, number> }
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
}
