import type { DatabaseSync } from 'node:sqlite'
import type {
  AssetKind,
  AssetVerdict,
  AssetVerdictValue,
  AttributionRow,
  OverrideSource
} from '../../../shared/attribution'
import type { CaseOutcome } from '../../../shared/caseOutcome'
import type { DossierCite } from '../../../shared/distillV3'
import { USAGE_PREDICATES, EFFECTIVE_CALLS } from '../observability/usagePredicates'
import { deriveCaseDomain } from '../../../shared/caseDomain'
import { deriveCaseOutcome } from '../../../shared/caseOutcome'
import { getCase } from '../caseService'
import { listStoredWorkspaces } from '../workspaces'

interface Raw {
  id: number
  case_id: number
  case_slug: string
  job_id: number
  asset_kind: string
  asset_name: string
  asset_tier: string | null
  applied: number | null
  verdict: string | null
  reason: string
  cites_json: string
  case_outcome: string
  case_domain: string
  judge_model: string
  prompt_hash: string
  override_verdict: string | null
  override_source: string | null
  override_at: string | null
  created_at: string
}

const SELECT = `SELECT a.*, c.slug AS case_slug FROM asset_attributions a JOIN cases c ON c.id = a.case_id`

function toRow(r: Raw): AttributionRow {
  let cites: DossierCite[] = []
  try {
    const parsed: unknown = JSON.parse(r.cites_json)
    cites = Array.isArray(parsed) ? (parsed as DossierCite[]) : []
  } catch {
    cites = []
  }
  return {
    id: r.id,
    caseId: r.case_id,
    caseSlug: r.case_slug,
    jobId: r.job_id,
    assetKind: r.asset_kind as AssetKind,
    assetName: r.asset_name,
    assetTier: r.asset_tier,
    applied: r.applied === null ? null : r.applied === 1,
    verdict: r.verdict as AssetVerdictValue | null,
    reason: r.reason,
    cites,
    caseOutcome: r.case_outcome as CaseOutcome,
    caseDomain: r.case_domain,
    judgeModel: r.judge_model,
    promptHash: r.prompt_hash,
    overrideVerdict: r.override_verdict as AssetVerdictValue | null,
    overrideSource: r.override_source as OverrideSource | null,
    overrideAt: r.override_at,
    createdAt: r.created_at
  }
}

interface InsertParams {
  caseId: number
  jobId: number
  kind: AssetKind
  name: string
  tier: string | null
  applied: number | null
  verdict: AssetVerdictValue | null
  reason: string
  citesJson: string
  caseOutcome: CaseOutcome
  caseDomain: string
  judgeModel: string
  promptHash: string
  at: string
}

/** The one INSERT for asset_attributions; returns the new row id. */
function insertRow(db: DatabaseSync, p: InsertParams): number {
  const res = db
    .prepare(
      `INSERT INTO asset_attributions (case_id, job_id, asset_kind, asset_name, asset_tier, applied, verdict, reason, cites_json, case_outcome, case_domain, judge_model, prompt_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.caseId,
      p.jobId,
      p.kind,
      p.name,
      p.tier,
      p.applied,
      p.verdict,
      p.reason,
      p.citesJson,
      p.caseOutcome,
      p.caseDomain,
      p.judgeModel,
      p.promptHash,
      p.at
    )
  return Number(res.lastInsertRowid)
}

/**
 * Idempotent per (case, job): queue.retry reuses a failed job's id, so a re-run replaces that
 * job's rows rather than doubling them. Delete + inserts share one transaction so a throw
 * mid-way cannot leave the job with its old rows gone and the new ones half-written.
 */
export function writeAttributions(
  db: DatabaseSync,
  p: {
    caseSlug: string
    jobId: number
    verdicts: AssetVerdict[]
    tiers: Map<string, string | null>
    caseOutcome: CaseOutcome
    caseDomain: string
    judgeModel: string
    promptHash: string
    now?: () => Date
  }
): AttributionRow[] {
  const c = getCase(db, p.caseSlug)
  if (!c) throw new Error(`Unknown case: ${p.caseSlug}`)
  const at = (p.now?.() ?? new Date()).toISOString()
  const ids: number[] = []
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM asset_attributions WHERE case_id = ? AND job_id = ?`).run(c.id, p.jobId)
    for (const v of p.verdicts) {
      ids.push(
        insertRow(db, {
          caseId: c.id,
          jobId: p.jobId,
          kind: v.kind,
          name: v.name,
          tier: p.tiers.get(`${v.kind}/${v.name}`) ?? null,
          applied: v.applied === null ? null : v.applied ? 1 : 0,
          verdict: v.verdict,
          reason: v.reason,
          citesJson: JSON.stringify(v.cites),
          caseOutcome: p.caseOutcome,
          caseDomain: p.caseDomain,
          judgeModel: p.judgeModel,
          promptHash: p.promptHash,
          at
        })
      )
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  if (ids.length === 0) return []
  return (
    db
      .prepare(`${SELECT} WHERE a.id IN (${ids.map(() => '?').join(',')}) ORDER BY a.id`)
      .all(...ids) as unknown as Raw[]
  ).map(toRow)
}

/**
 * `(case_id, job_id)` of the LATEST attribution job per case: the job owning the case's highest
 * `asset_attributions.id` — i.e. the job that most recently WROTE rows (spec §4.6). Not
 * MAX(job_id): queue.retry() re-runs a failed job under its ORIGINAL id, so a retried case job
 * (#10) that writes after an escape-hatch job (#11) must win even though 10 < 11 — and
 * writeAttributions' delete+insert gives the re-run fresh, higher row ids. Rows against a
 * dry-run job are excluded so they can never shadow the real job. The ONE definition: both the
 * aggregation read and the override writer use it, so they can never disagree on "latest".
 */
const LATEST_JOB_PER_CASE = `SELECT a.case_id, a.job_id FROM asset_attributions a
  JOIN (SELECT y.case_id, MAX(y.id) AS mid FROM asset_attributions y
          JOIN distill_jobs dj ON dj.id = y.job_id WHERE dj.dry_run = 0 GROUP BY y.case_id) m
    ON a.id = m.mid`

/** Rows of the latest attribution job per case — see LATEST_JOB_PER_CASE. */
export function latestAttributionRows(
  db: DatabaseSync,
  opts: { caseSlug?: string } = {}
): AttributionRow[] {
  const rows = db
    .prepare(
      `${SELECT}
       JOIN (${LATEST_JOB_PER_CASE}) l ON l.case_id = a.case_id AND l.job_id = a.job_id
       WHERE (? IS NULL OR c.slug = ?) ORDER BY a.id`
    )
    .all(opts.caseSlug ?? null, opts.caseSlug ?? null) as unknown as Raw[]
  return rows.map(toRow)
}

/** Stamp a human override on the latest job's row for this asset (creating a silent-judge row
 *  when there is none). Returns the changed row, or null when nothing changed: unknown case, no
 *  job to attach to, or the same override already stamped (a no-op is never re-emitted). */
export function applyAttributionOverride(
  db: DatabaseSync,
  p: {
    caseSlug: string
    kind: AssetKind
    name: string
    verdict: AssetVerdictValue
    source: OverrideSource
    now?: () => Date
  }
): AttributionRow | null {
  const c = getCase(db, p.caseSlug)
  if (!c) return null
  const at = (p.now?.() ?? new Date()).toISOString()
  const latest = db
    .prepare(`SELECT l.job_id AS j FROM (${LATEST_JOB_PER_CASE}) l WHERE l.case_id = ?`)
    .get(c.id) as { j: number } | undefined
  const latestJob = { j: latest?.j ?? null }
  let row =
    latestJob.j === null
      ? undefined
      : (db
          .prepare(
            `${SELECT} WHERE a.case_id = ? AND a.job_id = ? AND a.asset_kind = ? AND a.asset_name = ?`
          )
          .get(c.id, latestJob.j, p.kind, p.name) as unknown as Raw | undefined)
  if (!row) {
    const jobId =
      latestJob.j ??
      (
        db
          .prepare(
            `SELECT MAX(id) AS j FROM distill_jobs WHERE case_slug = ? AND kind = 'case' AND dry_run = 0`
          )
          .get(p.caseSlug) as { j: number | null }
      ).j
    if (jobId === null) return null
    const findings = db
      .prepare(`SELECT review_state AS reviewState, role FROM findings WHERE case_id = ?`)
      .all(c.id) as unknown as { reviewState: string; role: string | null }[]
    const id = insertRow(db, {
      caseId: c.id,
      jobId,
      kind: p.kind,
      name: p.name,
      tier: null,
      applied: 1,
      verdict: null,
      reason: '',
      citesJson: '[]',
      caseOutcome: deriveCaseOutcome(c, findings),
      caseDomain: deriveCaseDomain(c, listStoredWorkspaces(db, p.caseSlug)),
      judgeModel: 'none',
      promptHash: '',
      at
    })
    row = db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as unknown as Raw
  }
  // Already stamped with exactly this override → null: nothing changed, so the caller must not
  // re-emit (the Langfuse score id is deterministic, but a no-op should not reach the wire).
  if (row.override_source === p.source && row.override_verdict === p.verdict) return null
  // applied = COALESCE(applied, 1): a human override on a row the judge was silent about is itself
  // evidence the asset was in play; without this the aggregation (which skips applied IS NULL
  // rows as "silent") would ignore the override. An explicit applied = 0 is left alone.
  db.prepare(
    `UPDATE asset_attributions SET override_verdict = ?, override_source = ?, override_at = ?, applied = COALESCE(applied, 1) WHERE id = ?`
  ).run(p.verdict, p.source, at, row.id)
  return toRow(db.prepare(`${SELECT} WHERE a.id = ?`).get(row.id) as unknown as Raw)
}

export function assetNamesForCase(
  db: DatabaseSync,
  caseSlug: string
): { kind: AssetKind; name: string }[] {
  const c = getCase(db, caseSlug)
  if (!c) return []
  const out = new Map<string, { kind: AssetKind; name: string }>()
  for (const r of db
    .prepare(
      `SELECT asset_kind, asset_name FROM asset_attributions WHERE case_id = ?
       GROUP BY asset_kind, asset_name ORDER BY MIN(id)`
    )
    .all(c.id) as unknown as { asset_kind: AssetKind; asset_name: string }[])
    out.set(`${r.asset_kind}/${r.asset_name}`, { kind: r.asset_kind, name: r.asset_name })
  const live = (kind: AssetKind, where: string): void => {
    for (const r of db
      .prepare(
        `SELECT DISTINCT detail FROM tool_calls WHERE case_id = ? AND ${EFFECTIVE_CALLS} AND ${where}`
      )
      .all(c.id) as unknown as { detail: string }[]) {
      const name = kind === 'reference' ? r.detail.slice(4) : r.detail
      if (!name) continue // a bare `ref:` / empty detail names no asset (same rule as the inventory)
      if (!out.has(`${kind}/${name}`)) out.set(`${kind}/${name}`, { kind, name })
    }
  }
  live('skill', USAGE_PREDICATES.skill)
  live('reference', USAGE_PREDICATES.reference)
  live('memory', USAGE_PREDICATES.memory)
  return [...out.values()]
}

export function lastSessionIdForCase(db: DatabaseSync, caseSlug: string): number | null {
  const r = db
    .prepare(
      `SELECT s.id FROM sessions s JOIN cases c ON c.id = s.case_id WHERE c.slug = ? ORDER BY s.id DESC LIMIT 1`
    )
    .get(caseSlug) as { id: number } | undefined
  return r?.id ?? null
}
