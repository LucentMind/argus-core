import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  GlobalMetrics,
  MetricsQuery,
  MetricsSummary,
  ModelUsage
} from '../../../shared/observability'

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

function summary(
  db: DatabaseSync,
  caseFilter: { caseId?: number },
  q?: MetricsQuery
): MetricsSummary {
  const where: string[] = []
  const bind: SQLInputValue[] = []
  if (caseFilter.caseId != null) {
    where.push('case_id = ?')
    bind.push(caseFilter.caseId)
  }
  if (q?.since) {
    where.push('created_at >= ?')
    bind.push(q.since)
  }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(input_tokens),0) AS inTok,
            COALESCE(SUM(output_tokens),0) AS outTok, COUNT(*) AS total,
            SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors
     FROM turns ${W}`
    )
    .get(...bind) as { cost: number; inTok: number; outTok: number; total: number; errors: number }

  const byModel = db
    .prepare(
      `SELECT model, COALESCE(SUM(input_tokens),0) AS inTok, COALESCE(SUM(output_tokens),0) AS outTok,
            COALESCE(SUM(cost_usd),0) AS cost
     FROM turns ${W ? W + ' AND' : 'WHERE'} model IS NOT NULL
     GROUP BY model ORDER BY cost DESC`
    )
    .all(...bind) as { model: string; inTok: number; outTok: number; cost: number }[]

  const durs = (
    db
      .prepare(
        `SELECT duration_ms FROM turns ${W ? W + ' AND' : 'WHERE'} duration_ms IS NOT NULL ORDER BY duration_ms`
      )
      .all(...bind) as { duration_ms: number }[]
  ).map((r) => r.duration_ms)

  const tools = db
    .prepare(`SELECT decision, risk, COUNT(*) AS n FROM tool_calls ${W} GROUP BY decision, risk`)
    .all(...bind) as { decision: string; risk: string; n: number }[]
  const byDecision: Record<string, number> = {}
  const byRisk: Record<string, number> = {}
  let toolTotal = 0
  let denied = 0
  for (const t of tools) {
    byDecision[t.decision] = (byDecision[t.decision] ?? 0) + t.n
    byRisk[t.risk] = (byRisk[t.risk] ?? 0) + t.n
    toolTotal += t.n
    if (t.decision === 'denied' || t.decision === 'cancelled') denied += t.n
  }

  const fRows = db
    .prepare(`SELECT review_state, COUNT(*) AS n FROM findings ${W} GROUP BY review_state`)
    .all(...bind) as { review_state: string; n: number }[]
  const findings = { total: 0, accepted: 0, rejected: 0, pending: 0 }
  for (const f of fRows) {
    findings.total += f.n
    if (f.review_state === 'accepted') findings.accepted += f.n
    else if (f.review_state === 'rejected') findings.rejected += f.n
    else findings.pending += f.n
  }

  const models: ModelUsage[] = byModel.map((m) => ({
    model: m.model,
    inputTokens: m.inTok,
    outputTokens: m.outTok,
    costUsd: m.cost
  }))
  return {
    totalCostUsd: totals.cost,
    inputTokens: totals.inTok,
    outputTokens: totals.outTok,
    byModel: models,
    turns: { total: totals.total, error: totals.errors ?? 0 },
    tools: { total: toolTotal, denied, byDecision, byRisk },
    findings,
    latencyMs: { turnP50: percentile(durs, 50), turnP95: percentile(durs, 95) }
  }
}

export function caseMetrics(db: DatabaseSync, caseSlug: string, q?: MetricsQuery): MetricsSummary {
  const row = db.prepare(`SELECT id FROM cases WHERE slug = ?`).get(caseSlug) as
    { id: number } | undefined
  if (!row) throw new Error(`Unknown case: ${caseSlug}`)
  return summary(db, { caseId: row.id }, q)
}

export function globalMetrics(db: DatabaseSync, q?: MetricsQuery): GlobalMetrics {
  const base = summary(db, {}, q)
  const resolved = db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE status = 'closed'`).get() as {
    n: number
  }
  const closedCost = db
    .prepare(
      `SELECT COALESCE(SUM(t.cost_usd),0) AS cost FROM turns t JOIN cases c ON c.id = t.case_id WHERE c.status = 'closed'`
    )
    .get() as { cost: number }
  return {
    ...base,
    resolvedCases: resolved.n,
    costPerResolvedCaseUsd: resolved.n > 0 ? closedCost.cost / resolved.n : null
  }
}
