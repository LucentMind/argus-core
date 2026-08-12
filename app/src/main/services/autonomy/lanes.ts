// app/src/main/services/autonomy/lanes.ts
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  type DecisionRow,
  type LaneId,
  type LaneMetrics,
  type TriageClock
} from '../../../shared/autonomy'
import { listArchivedProposals } from '../proposals'
import { evidenceDir } from '../paths'

export interface LaneDeps {
  db: DatabaseSync
  argusHome: string
  now?: () => Date
}

function sinceIso(deps: LaneDeps, windowDays: number | null): string | null {
  if (windowDays === null) return null
  const now = (deps.now ?? (() => new Date()))()
  return new Date(now.getTime() - windowDays * 24 * 3600 * 1000).toISOString()
}

function inWindow(decidedAt: string | null, since: string | null): boolean {
  if (since === null) return true // all-time: unstamped rows count too
  return decidedAt !== null && decidedAt >= since
}

// ——— per-lane decision listers ———————————————————————————————————————————

function triageDecisions(deps: LaneDeps): DecisionRow[] {
  const rows = deps.db
    .prepare(
      `SELECT c.slug, c.review_state, c.triaged_at,
              (SELECT SUM(t.cost_usd) FROM routine_runs rr JOIN turns t ON t.session_id = rr.session_id
               WHERE rr.case_slug = c.slug) AS cost
       FROM cases c WHERE c.origin = 'routine' AND c.triaged_at IS NOT NULL`
    )
    .all() as {
    slug: string
    review_state: string | null
    triaged_at: string
    cost: number | null
  }[]
  return rows.map((r) => ({
    lane: 'triage' as const,
    sourceId: r.slug,
    caseSlug: r.slug,
    decidedAt: r.triaged_at,
    // dismiss deliberately leaves review_state='draft' (routines/service.ts) — that IS the
    // rejected marker; accept clears it to NULL.
    outcome: r.review_state === null ? ('accepted' as const) : ('rejected' as const),
    detail: null,
    costUsd: r.cost
  }))
}

function distillDecisions(deps: LaneDeps): DecisionRow[] {
  return listArchivedProposals(deps.argusHome)
    .filter((p) => p.type !== 'case-summary')
    .map((p) => ({
      lane: 'distill' as const,
      sourceId: p.file,
      caseSlug: p.caseSlug || null,
      decidedAt: p.decided,
      outcome: p.status,
      detail: p.rejectReason,
      costUsd: null // headless distill runs have no session row — unattributable, never estimated
    }))
}

function reviewFindingDecisions(deps: LaneDeps): DecisionRow[] {
  const rows = deps.db
    .prepare(
      `SELECT f.id, f.review_state, f.reviewed_at, c.slug
       FROM findings f
       JOIN sessions s ON s.id = f.session_id
       JOIN cases c ON c.id = f.case_id
       WHERE s.mode = 'review' AND f.review_state IN ('accepted','rejected')`
    )
    .all() as {
    id: number
    review_state: 'accepted' | 'rejected'
    reviewed_at: string | null
    slug: string
  }[]
  return rows.map((r) => ({
    lane: 'review-finding' as const,
    sourceId: String(r.id),
    caseSlug: r.slug,
    decidedAt: r.reviewed_at,
    outcome: r.review_state,
    detail: null,
    costUsd: null // lane cost is computed session-wide below, not per finding
  }))
}

function rcaDecisions(deps: LaneDeps): DecisionRow[] {
  const rows = deps.db
    .prepare(
      `SELECT id, case_slug, confirmed_at, finished_at,
              id = (SELECT MAX(id) FROM rca_jobs j2 WHERE j2.case_slug = rca_jobs.case_slug AND j2.state = 'done') AS newest
       FROM rca_jobs WHERE state = 'done' ORDER BY id`
    )
    .all() as {
    id: number
    case_slug: string
    confirmed_at: string | null
    finished_at: string | null
    newest: number
  }[]
  const out: DecisionRow[] = []
  for (const r of rows) {
    if (r.confirmed_at !== null) {
      out.push({
        lane: 'rca',
        sourceId: String(r.id),
        caseSlug: r.case_slug,
        decidedAt: r.confirmed_at,
        outcome: 'accepted',
        detail: null,
        costUsd: null
      })
    } else if (!r.newest) {
      // superseded without ever being confirmed — the human implicitly rejected it by
      // regenerating; the newest unconfirmed job is still awaiting review (pending, no row).
      out.push({
        lane: 'rca',
        sourceId: String(r.id),
        caseSlug: r.case_slug,
        decidedAt: r.finished_at,
        outcome: 'rejected',
        detail: 'superseded',
        costUsd: null
      })
    }
  }
  return out
}

export function listDecisions(
  deps: LaneDeps,
  lane: LaneId,
  windowDays: number | null
): DecisionRow[] {
  const all =
    lane === 'triage'
      ? triageDecisions(deps)
      : lane === 'distill'
        ? distillDecisions(deps)
        : lane === 'review-finding'
          ? reviewFindingDecisions(deps)
          : rcaDecisions(deps)
  const since = sinceIso(deps, windowDays)
  return all.filter((d) => inWindow(d.decidedAt, since))
}

// ——— depth + lane-level cost ———————————————————————————————————————————————

function count(db: DatabaseSync, sql: string, bind: (string | number)[]): number {
  return (db.prepare(sql).get(...bind) as { n: number }).n
}

function laneDepth(deps: LaneDeps, lane: LaneId, since: string | null): Record<string, number> {
  const db = deps.db
  if (lane === 'review-finding') {
    const w = (col: string): [string, string[]] =>
      since === null ? [`${col} IS NOT NULL`, []] : [`${col} IS NOT NULL AND ${col} >= ?`, [since]]
    const [pw, pb] = w('f.posted_at')
    const [aw, ab] = w('f.pushed_at')
    const base = `FROM findings f JOIN sessions s ON s.id = f.session_id WHERE s.mode = 'review' AND `
    return {
      posted: count(db, `SELECT COUNT(*) AS n ${base}${pw}`, pb),
      applied: count(db, `SELECT COUNT(*) AS n ${base}${aw}`, ab)
    }
  }
  if (lane === 'rca') {
    const generated =
      since === null
        ? count(db, `SELECT COUNT(*) AS n FROM rca_jobs WHERE state = 'done'`, [])
        : count(
            db,
            `SELECT COUNT(*) AS n FROM rca_jobs WHERE state = 'done' AND finished_at >= ?`,
            [since]
          )
    const confirmed =
      since === null
        ? count(db, `SELECT COUNT(*) AS n FROM rca_jobs WHERE confirmed_at IS NOT NULL`, [])
        : count(db, `SELECT COUNT(*) AS n FROM rca_jobs WHERE confirmed_at >= ?`, [since])
    const postedRows = (
      since === null
        ? db.prepare(`SELECT post_results FROM rca_jobs WHERE post_results IS NOT NULL`).all()
        : db
            .prepare(
              `SELECT post_results FROM rca_jobs WHERE post_results IS NOT NULL AND confirmed_at >= ?`
            )
            .all(since)
    ) as { post_results: string }[]
    let postedOk = 0
    for (const r of postedRows) {
      try {
        const p = JSON.parse(r.post_results) as Record<string, { ok?: boolean } | undefined>
        if (Object.values(p).some((t) => t?.ok)) postedOk++
      } catch {
        /* dirty json — skip, never crash an aggregate */
      }
    }
    return { generated, confirmed, postedOk }
  }
  return {}
}

function laneCost(deps: LaneDeps, lane: LaneId, since: string | null): number | null {
  const db = deps.db
  if (lane === 'review-finding') {
    const r = (
      since === null
        ? db
            .prepare(
              `SELECT COALESCE(SUM(t.cost_usd),0) AS c FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.mode = 'review'`
            )
            .get()
        : db
            .prepare(
              `SELECT COALESCE(SUM(t.cost_usd),0) AS c FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.mode = 'review' AND t.created_at >= ?`
            )
            .get(since)
    ) as { c: number }
    return r.c
  }
  return null // triage sums per-row cost in laneMetrics; distill/rca are unattributable
}

// ——— metrics ————————————————————————————————————————————————————————————————

export function laneMetrics(deps: LaneDeps, lane: LaneId, windowDays: number | null): LaneMetrics {
  const since = sinceIso(deps, windowDays)
  const rows = listDecisions(deps, lane, windowDays)
  const accepted = rows.filter((r) => r.outcome === 'accepted').length
  const rejectReasons: Record<string, number> = {}
  if (lane === 'distill') {
    for (const r of rows) {
      if (r.outcome === 'rejected') {
        const tag = r.detail ?? 'untagged'
        rejectReasons[tag] = (rejectReasons[tag] ?? 0) + 1
      }
    }
  }
  let costUsd = laneCost(deps, lane, since)
  if (lane === 'triage') {
    const sum = rows.reduce((a, r) => a + (r.costUsd ?? 0), 0)
    costUsd = rows.some((r) => r.costUsd !== null) ? sum : null
  }
  // dataStart is computed all-time so a 7-day view still reports when honest data began.
  const stamped = listDecisions(deps, lane, null)
    .map((r) => r.decidedAt)
    .filter((d): d is string => d !== null)
    .sort()
  return {
    lane,
    windowDays,
    decisions: rows.length,
    accepted,
    acceptanceRate: rows.length > 0 ? accepted / rows.length : null,
    costUsd,
    rejectReasons,
    depth: laneDepth(deps, lane, since),
    dataStart: stamped[0] ?? null
  }
}

// ——— time in triage ————————————————————————————————————————————————————————

function ticketCreated(deps: LaneDeps, slug: string, jiraKey: string | null): string | null {
  if (!jiraKey) return null
  try {
    const raw = fs.readFileSync(
      path.join(evidenceDir(deps.argusHome, slug), `${jiraKey}.ticket.json`),
      'utf8'
    )
    const created = (JSON.parse(raw) as { fields?: { created?: string } }).fields?.created
    return typeof created === 'string' ? created : null
  } catch {
    return null // absent or unparseable — fall back to cases.created_at
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

export function timeInTriage(deps: LaneDeps, windowDays: number | null): TriageClock {
  const since = sinceIso(deps, windowDays)
  const rows = deps.db
    .prepare(
      `SELECT c.slug, c.jira_key, c.created_at,
              (SELECT MIN(f.created_at) FROM findings f WHERE f.case_id = c.id AND f.role = 'root-cause') AS rc_at,
              (SELECT MIN(r.confirmed_at) FROM rca_jobs r WHERE r.case_slug = c.slug AND r.confirmed_at IS NOT NULL) AS rca_at
       FROM cases c`
    )
    .all() as {
    slug: string
    jira_key: string | null
    created_at: string
    rc_at: string | null
    rca_at: string | null
  }[]
  const durations: number[] = []
  for (const r of rows) {
    const stop = r.rc_at ?? r.rca_at
    if (!stop) continue // still in triage — not a datapoint
    if (since !== null && stop < since) continue
    const start = ticketCreated(deps, r.slug, r.jira_key) ?? r.created_at
    const ms = new Date(stop).getTime() - new Date(start).getTime()
    if (Number.isFinite(ms) && ms >= 0) durations.push(ms) // negative = dirty import, skip
  }
  durations.sort((a, b) => a - b)
  return {
    medianMs: percentile(durations, 50),
    p90Ms: percentile(durations, 90),
    cases: durations.length
  }
}
