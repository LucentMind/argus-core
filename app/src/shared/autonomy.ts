/**
 * Autonomy ledger contract (spec 2026-08-11-autonomy-ledger-design §"Telemetry-ready
 * contract"). Every payload here is plain JSON — the Autonomy page, the day-90 report
 * renderer, and the future telemetry uploader all consume these same shapes. Bump
 * AUTONOMY_CONTRACT_VERSION on any breaking field change.
 */
export const AUTONOMY_CONTRACT_VERSION = 1

export const LANES = ['triage', 'distill', 'review-finding', 'rca'] as const
export type LaneId = (typeof LANES)[number]

export const LANE_LABELS: Record<LaneId, string> = {
  triage: 'Triage suggestions',
  distill: 'Distill proposals',
  'review-finding': 'Review findings',
  rca: 'RCA reports'
}

/** Deck "today" markers: review write-actions already run at A3; the rest are A1
 *  (analyze & recommend, human applies). A lane at its baseline never auto-demotes. */
export const LANE_BASELINES: Record<LaneId, number> = {
  triage: 1,
  distill: 1,
  'review-finding': 3,
  rca: 1
}

export const TIER_MIN = 0
export const TIER_MAX = 6

/** One normalized supervised decision. `sourceId` is stable and unique within the lane
 *  (finding id / archive filename / case slug / rca job id) so a telemetry uploader can
 *  cursor on (lane, decidedAt, sourceId). `decidedAt: null` = record predates the outcome
 *  stamps — counted all-time, excluded from every window. */
export interface DecisionRow {
  lane: LaneId
  sourceId: string
  caseSlug: string | null
  decidedAt: string | null
  outcome: 'accepted' | 'rejected'
  /** Lane-specific: reject-reason tag (distill), 'posted'/'applied' depth marker source
   *  (review-finding — informational), post target (rca). */
  detail: string | null
  /** null = unattributable (headless distill/RCA runs have no session row — honest accounting). */
  costUsd: number | null
}

export interface LaneMetrics {
  lane: LaneId
  /** null = all-time. */
  windowDays: number | null
  decisions: number
  accepted: number
  /** accepted/decisions; null when decisions === 0. Bar gating is separate (clearsBar). */
  acceptanceRate: number | null
  /** Lane-attributable cost in the window; null = unattributable for this lane. */
  costUsd: number | null
  /** Distill only; {} elsewhere. */
  rejectReasons: Record<string, number>
  /** Depth signals: review-finding {posted, applied}; rca {generated, confirmed, postedOk}. */
  depth: Record<string, number>
  /** Earliest stamped decidedAt this lane has (all-time) — the report's data-start caveat. */
  dataStart: string | null
}

export type AutonomyEventKind = 'promote' | 'demote' | 'auto-demote'

export interface AutonomyEventRow {
  id: number
  lane: LaneId
  kind: AutonomyEventKind
  fromTier: number
  toTier: number
  note: string | null
  /** The lane's windowed metrics frozen at decision time — the audit trail. */
  metricsSnapshot: LaneMetrics
  createdAt: string
  /** Only meaningful on 'auto-demote'; non-null once a human clicked "acknowledge". */
  acknowledgedAt: string | null
}

export interface LaneBar {
  minDecisions: number
  minAcceptanceRate: number
}

/** Settings shape (mirrors settingsSchema's autonomy section — kept structural, not z.infer,
 *  so this file stays importable by main and renderer without dragging zod along). */
export interface AutonomySettings {
  windowDays: number
  bars: Record<string, Partial<LaneBar> | undefined>
}

export const DEFAULT_BAR: LaneBar = { minDecisions: 10, minAcceptanceRate: 0.8 }

export function barFor(s: AutonomySettings, lane: LaneId): LaneBar {
  const b = s.bars[lane]
  return {
    minDecisions: b?.minDecisions ?? DEFAULT_BAR.minDecisions,
    minAcceptanceRate: b?.minAcceptanceRate ?? DEFAULT_BAR.minAcceptanceRate
  }
}

/** The graduation rule: a lane clears its bar only with enough windowed volume AND rate. */
export function clearsBar(m: LaneMetrics, bar: LaneBar): boolean {
  return (
    m.decisions >= bar.minDecisions &&
    m.acceptanceRate !== null &&
    m.acceptanceRate >= bar.minAcceptanceRate
  )
}

export interface LaneStatus {
  lane: LaneId
  label: string
  tier: number
  baseline: number
  bar: LaneBar
  clearsBar: boolean
  metrics: LaneMetrics
  allTime: LaneMetrics
  events: AutonomyEventRow[]
}

export interface TriageClock {
  /** Milliseconds; null when no case in the window has a routed root-cause hypothesis. */
  medianMs: number | null
  p90Ms: number | null
  cases: number
}

export interface AutonomyPayload {
  contractVersion: typeof AUTONOMY_CONTRACT_VERSION
  argusVersion: string
  /** Stable per-install random id — distinguishes multi-workstation data server-side later. */
  instanceId: string
  windowDays: number
  lanes: LaneStatus[]
  unackedDemotions: number
  timeInTriage: TriageClock
  costPerResolvedCaseUsd: number | null
  resolvedCases: number
}
