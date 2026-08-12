import type { DatabaseSync } from 'node:sqlite'
import {
  LANE_BASELINES,
  TIER_MAX,
  TIER_MIN,
  type AutonomyEventKind,
  type AutonomyEventRow,
  type LaneId,
  type LaneMetrics
} from '../../../shared/autonomy'

interface Raw {
  id: number
  lane: string
  kind: string
  from_tier: number
  to_tier: number
  note: string | null
  metrics_snapshot: string
  created_at: string
  acknowledged_at: string | null
}

function toRow(r: Raw): AutonomyEventRow {
  return {
    id: r.id,
    lane: r.lane as LaneId,
    kind: r.kind as AutonomyEventKind,
    fromTier: r.from_tier,
    toTier: r.to_tier,
    note: r.note,
    metricsSnapshot: JSON.parse(r.metrics_snapshot) as LaneMetrics,
    createdAt: r.created_at,
    acknowledgedAt: r.acknowledged_at
  }
}

export function listEvents(db: DatabaseSync, lane?: LaneId): AutonomyEventRow[] {
  const rows = (
    lane
      ? db.prepare(`SELECT * FROM autonomy_events WHERE lane = ? ORDER BY id DESC`).all(lane)
      : db.prepare(`SELECT * FROM autonomy_events ORDER BY id DESC`).all()
  ) as unknown as Raw[]
  return rows.map(toRow)
}

/** Latest event wins; a lane with no history sits at its deck-derived baseline. */
export function currentTier(db: DatabaseSync, lane: LaneId): number {
  const r = db
    .prepare(`SELECT to_tier FROM autonomy_events WHERE lane = ? ORDER BY id DESC LIMIT 1`)
    .get(lane) as { to_tier: number } | undefined
  return r ? r.to_tier : LANE_BASELINES[lane]
}

export function addEvent(
  db: DatabaseSync,
  e: {
    lane: LaneId
    kind: AutonomyEventKind
    toTier: number
    note?: string | null
    metricsSnapshot: LaneMetrics
    now?: Date
  }
): AutonomyEventRow {
  const fromTier = currentTier(db, e.lane)
  const toTier = Math.max(TIER_MIN, Math.min(TIER_MAX, e.toTier))
  if (toTier === fromTier) throw new Error(`no-op tier change for ${e.lane} (A${fromTier})`)
  const createdAt = (e.now ?? new Date()).toISOString()
  const res = db
    .prepare(
      `INSERT INTO autonomy_events (lane, kind, from_tier, to_tier, note, metrics_snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(e.lane, e.kind, fromTier, toTier, e.note ?? null, JSON.stringify(e.metricsSnapshot), createdAt)
  return {
    id: Number(res.lastInsertRowid),
    lane: e.lane,
    kind: e.kind,
    fromTier,
    toTier,
    note: e.note ?? null,
    metricsSnapshot: e.metricsSnapshot,
    createdAt,
    acknowledgedAt: null
  }
}

export function ackEvent(db: DatabaseSync, id: number, now: Date = new Date()): void {
  db.prepare(
    `UPDATE autonomy_events SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?`
  ).run(now.toISOString(), id)
}

export function unackedDemotions(db: DatabaseSync): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM autonomy_events WHERE kind = 'auto-demote' AND acknowledged_at IS NULL`
    )
    .get() as { n: number }
  return r.n
}
