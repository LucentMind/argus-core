import type { DatabaseSync } from 'node:sqlite'
import {
  LANES,
  LANE_BASELINES,
  barFor,
  type AutonomyEventRow,
  type LaneId
} from '../../../shared/autonomy'
import type { AppSettings } from '../../../shared/settings'
import { laneMetrics, listDecisions, type LaneDeps } from './lanes'
import { addEvent, currentTier, listEvents } from './ledger'

export interface EvaluatorDeps {
  db: DatabaseSync
  argusHome: string
  settings: () => AppSettings
  /** Fired once per evaluation that inserted at least one event. Must never throw upstream —
   *  wire it to the autonomyChanged broadcast. */
  onChanged: () => void
  now?: () => Date
  debounceMs?: number
}

/**
 * The deck's demotion half of the graduation rule: "demotion is automatic when quality
 * dips". Fail-quiet by design — an aggregation error skips the lane and logs; the evaluator
 * must never insert an event off partial data and never crash the app over a metric.
 */
export class AutonomyEvaluator {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private deps: EvaluatorDeps) {}

  evaluateSoon(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.evaluateNow()
    }, this.deps.debounceMs ?? 1000)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  evaluateNow(): AutonomyEventRow[] {
    const inserted: AutonomyEventRow[] = []
    for (const lane of LANES) {
      try {
        const e = this.evaluateLane(lane)
        if (e) inserted.push(e)
      } catch (err) {
        console.warn(`autonomy evaluator: lane ${lane} skipped:`, err)
      }
    }
    if (inserted.length > 0) this.deps.onChanged()
    return inserted
  }

  private evaluateLane(lane: LaneId): AutonomyEventRow | null {
    const { db } = this.deps
    const tier = currentTier(db, lane)
    if (tier <= LANE_BASELINES[lane]) return null // a lane at baseline never auto-demotes

    const auto = this.deps.settings().autonomy
    const bar = barFor(auto, lane)
    const laneDeps: LaneDeps = { db, argusHome: this.deps.argusHome, now: this.deps.now }
    const m = laneMetrics(laneDeps, lane, auto.windowDays)
    if (m.decisions < bar.minDecisions) return null // sparse data never demotes
    if (m.acceptanceRate === null || m.acceptanceRate >= bar.minAcceptanceRate) return null

    // Single-fire guard: after an auto-demotion, stay quiet until a NEW decision lands —
    // re-evaluating the same window forever would ratchet a lane to A0 off one bad week.
    const lastAuto = listEvents(db, lane).find((e) => e.kind === 'auto-demote')
    if (lastAuto) {
      const fresh = listDecisions(laneDeps, lane, null).some(
        (d) => d.decidedAt !== null && d.decidedAt > lastAuto.createdAt
      )
      if (!fresh) return null
    }

    return addEvent(db, {
      lane,
      kind: 'auto-demote',
      toTier: tier - 1,
      note: null,
      metricsSnapshot: m
    })
  }
}
