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
    cites = JSON.parse(r.cites_json) as DossierCite[]
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
  const ins = db.prepare(
    `INSERT INTO asset_attributions (case_id, job_id, asset_kind, asset_name, asset_tier, applied, verdict, reason, cites_json, case_outcome, case_domain, judge_model, prompt_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const ids: number[] = []
  for (const v of p.verdicts) {
    const res = ins.run(
      c.id,
      p.jobId,
      v.kind,
      v.name,
      p.tiers.get(`${v.kind}/${v.name}`) ?? null,
      v.applied === null ? null : v.applied ? 1 : 0,
      v.verdict,
      v.reason,
      JSON.stringify(v.cites),
      p.caseOutcome,
      p.caseDomain,
      p.judgeModel,
      p.promptHash,
      at
    )
    ids.push(Number(res.lastInsertRowid))
  }
  if (ids.length === 0) return []
  return (
    db
      .prepare(`${SELECT} WHERE a.id IN (${ids.map(() => '?').join(',')}) ORDER BY a.id`)
      .all(...ids) as unknown as Raw[]
  ).map(toRow)
}

/** Rows of the LATEST job per case that produced attribution rows (spec §4.6). */
export function latestAttributionRows(
  db: DatabaseSync,
  opts: { caseSlug?: string } = {}
): AttributionRow[] {
  const rows = db
    .prepare(
      `${SELECT}
       JOIN (SELECT case_id, MAX(job_id) AS job_id FROM asset_attributions GROUP BY case_id) l
         ON l.case_id = a.case_id AND l.job_id = a.job_id
       WHERE (? IS NULL OR c.slug = ?) ORDER BY a.id`
    )
    .all(opts.caseSlug ?? null, opts.caseSlug ?? null) as unknown as Raw[]
  return rows.map(toRow)
}

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
  const latestJob = db
    .prepare(`SELECT MAX(job_id) AS j FROM asset_attributions WHERE case_id = ?`)
    .get(c.id) as { j: number | null }
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
        db.prepare(`SELECT MAX(id) AS j FROM distill_jobs WHERE case_slug = ?`).get(p.caseSlug) as {
          j: number | null
        }
      ).j
    if (jobId === null) return null
    const findings = db
      .prepare(`SELECT review_state AS reviewState, role FROM findings WHERE case_id = ?`)
      .all(c.id) as unknown as { reviewState: string; role: string | null }[]
    const res = db
      .prepare(
        `INSERT INTO asset_attributions (case_id, job_id, asset_kind, asset_name, asset_tier, applied, verdict, reason, cites_json, case_outcome, case_domain, judge_model, prompt_hash, created_at)
       VALUES (?, ?, ?, ?, NULL, 1, NULL, '', '[]', ?, ?, 'none', '', ?)`
      )
      .run(
        c.id,
        jobId,
        p.kind,
        p.name,
        deriveCaseOutcome(c, findings),
        deriveCaseDomain(c, listStoredWorkspaces(db, p.caseSlug)),
        at
      )
    row = db.prepare(`${SELECT} WHERE a.id = ?`).get(Number(res.lastInsertRowid)) as unknown as Raw
  }
  if (row.override_source === p.source && row.override_verdict === p.verdict) return toRow(row)
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
      `SELECT DISTINCT asset_kind, asset_name FROM asset_attributions WHERE case_id = ? ORDER BY id`
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
