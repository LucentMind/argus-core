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

export type FindingRole = 'root-cause' | 'contributing' | 'symptom' | 'ruled-out' | 'duplicate'
export const FINDING_ROLES: FindingRole[] = [
  'root-cause',
  'contributing',
  'symptom',
  'ruled-out',
  'duplicate'
]
export function isFindingRole(v: unknown): v is FindingRole {
  return typeof v === 'string' && (FINDING_ROLES as string[]).includes(v)
}

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
  /** RCA role assigned to this finding (root-cause / contributing / symptom / ruled-out /
   *  duplicate); null on findings that haven't been triaged into an RCA yet. */
  role: FindingRole | null
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
/** Distillation cost/usage rollup over completed case runs (`kind='case' AND state='done'`),
 *  Task 12's widened `distill_jobs` columns. `AVG`/`SUM` are SQL-level and ignore NULL rows
 *  (pre-v2 done jobs recorded no usage), so the averages are never diluted by fabricated zeros —
 *  `jobCount` alone tells you how many done runs exist, independent of how many of them have
 *  usage data. */
export interface DistillationUsageStats {
  jobCount: number
  totalCostUsd: number | null
  avgCostUsd: number | null
  avgPromptChars: number | null
  avgTurnCount: number | null
  /** Cost spent on `failed` case-distill jobs — a failed capHit run still ran the whole agent
   *  loop before refusing to parse, so it is often the MOST expensive outcome, not a free one.
   *  Separate from `totalCostUsd` (done-only): `jobCount`/every average above stay scoped to
   *  completed jobs, this is the one field that also sees failed spend. */
  failedCostUsd: number | null
}

export interface UsageStatsPayload {
  hygiene: { staleDays: number; minRecalls: number; trackingStartedAt: string }
  skills: SkillUsageRow[]
  memory: MemoryUsageRow[]
  references: ReferenceUsageRow[]
  archived: ArchivedTopicRow[]
  distillation: DistillationUsageStats
}
