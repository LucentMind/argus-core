import {
  AUTONOMY_CONTRACT_VERSION,
  LANES,
  LANE_BASELINES,
  LANE_LABELS,
  barFor,
  clearsBar,
  type AutonomyPayload,
  type LaneStatus
} from '../../../shared/autonomy'
import type { AppSettings } from '../../../shared/settings'
import { globalMetrics } from '../observability/metrics'
import { ensureInstanceId } from './instanceId'
import { laneMetrics, timeInTriage, type LaneDeps } from './lanes'
import { currentTier, listEvents, unackedDemotions } from './ledger'

export type PayloadDeps = LaneDeps & {
  settings: () => AppSettings
  argusVersion: string
}

export function buildAutonomyPayload(deps: PayloadDeps): AutonomyPayload {
  const auto = deps.settings().autonomy
  const lanes: LaneStatus[] = LANES.map((lane) => {
    const bar = barFor(auto, lane)
    const metrics = laneMetrics(deps, lane, auto.windowDays)
    return {
      lane,
      label: LANE_LABELS[lane],
      tier: currentTier(deps.db, lane),
      baseline: LANE_BASELINES[lane],
      bar,
      clearsBar: clearsBar(metrics, bar),
      metrics,
      allTime: laneMetrics(deps, lane, null),
      events: listEvents(deps.db, lane)
    }
  })
  const g = globalMetrics(deps.db)
  return {
    contractVersion: AUTONOMY_CONTRACT_VERSION,
    argusVersion: deps.argusVersion,
    instanceId: ensureInstanceId(deps.argusHome),
    windowDays: auto.windowDays,
    lanes,
    unackedDemotions: unackedDemotions(deps.db),
    timeInTriage: timeInTriage(deps, auto.windowDays),
    costPerResolvedCaseUsd: g.costPerResolvedCaseUsd,
    resolvedCases: g.resolvedCases
  }
}
