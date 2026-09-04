import type { DatabaseSync } from 'node:sqlite'
import type { AppSettings } from '../../../shared/settings'
import type { AgentAccess } from '../../../shared/agentAccess'
import type {
  UsageStatsPayload,
  SkillUsageRow,
  DistillationUsageStats
} from '../../../shared/observability'
import { listReferenceFiles } from '../refSync/referenceFiles'
import { resolveSkills } from '../agent/skillsResolver'
import { listTopics } from '../memory'
import { isStaleCandidate, listArchivedTopics, type HygieneConfig } from '../memoryHygiene'
import { sharedReferencesDir } from '../skillsDir'

/** Stamp the usage-tracking epoch exactly once; before it elapses staleDays no topic can be
 *  flagged stale (recall tracking hasn't had a fair observation window). */
export function ensureTrackingStarted(
  settings: { get(): AppSettings; patch(p: unknown): AppSettings },
  now: () => Date = () => new Date()
): string {
  const cur = settings.get().memoryHygiene.trackingStartedAt
  if (cur) return cur
  return settings.patch({ memoryHygiene: { trackingStartedAt: now().toISOString() } }).memoryHygiene
    .trackingStartedAt
}

export interface UsageStatsDeps {
  db: DatabaseSync
  argusHome: string
  access: AgentAccess
  hygiene: HygieneConfig
  now?: () => Date
  /** ISO lower-bound on `finished_at`; unset means all-time. */
  since?: string
}

interface CountRow {
  detail: string
  n: number
  last: string
}

interface DistillationRow {
  n: number
  total_cost: number | null
  avg_cost: number | null
  avg_prompt: number | null
  avg_turn: number | null
  failed_cost: number | null
  failed_n: number
}

/** Rollup over case distill jobs. `n`/`total_cost`/`avg_*` stay scoped to `done` rows exactly as
 *  before (via the `CASE WHEN` guards, not the outer `WHERE`) — `COUNT`/`SUM`/`AVG` skip NULL
 *  inputs on their own, so a pre-v2 done row (every usage column NULL) lowers no average, and an
 *  all-pre-v2 history reports a real jobCount with every average staying null rather than 0.
 *  `failed_cost`/`failed_n` are the columns that also see `failed` rows: a failed capHit run
 *  still ran the whole agent loop before refusing to parse, so its spend is real and must not
 *  vanish just because the job never became `done`. The outer `WHERE` widens to
 *  `state IN ('done','failed')` only so those two columns have failed rows to see — it changes
 *  nothing for the done-only columns. `dry_run = 0` keeps comparison runs out of this rollup
 *  entirely: these stats answer "what does real distillation cost", and a dry run's spend isn't
 *  part of that — mixing it in would make the per-case cost/turn/prompt averages misleading (dry
 *  spend is reported separately via `dryRunCount`/`dryRunCostUsd`). `since` (when given) bounds
 *  both this query and the dry-run query below on `finished_at`, so a "recent" window can't
 *  include a job that finished before it. */
function distillationStats(db: DatabaseSync, since?: string): DistillationUsageStats {
  const row = db
    .prepare(
      `SELECT SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS n,
              SUM(CASE WHEN state = 'done' THEN cost_usd END) AS total_cost,
              AVG(CASE WHEN state = 'done' THEN cost_usd END) AS avg_cost,
              AVG(CASE WHEN state = 'done' THEN prompt_chars END) AS avg_prompt,
              AVG(CASE WHEN state = 'done' THEN turn_count END) AS avg_turn,
              SUM(CASE WHEN state = 'failed' THEN cost_usd END) AS failed_cost,
              SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed_n
       FROM distill_jobs
       WHERE kind = 'case' AND state IN ('done', 'failed') AND dry_run = 0
         AND (? IS NULL OR finished_at >= ?)`
    )
    .get(since ?? null, since ?? null) as unknown as DistillationRow
  const dry = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(cost_usd) AS c FROM distill_jobs
       WHERE kind = 'case' AND state IN ('done', 'failed') AND dry_run = 1
         AND (? IS NULL OR finished_at >= ?)`
    )
    .get(since ?? null, since ?? null) as unknown as { n: number; c: number | null }
  return {
    jobCount: row.n ?? 0,
    totalCostUsd: row.total_cost,
    avgCostUsd: row.avg_cost,
    avgPromptChars: row.avg_prompt,
    avgTurnCount: row.avg_turn,
    failedCostUsd: row.failed_cost,
    failedCount: row.failed_n ?? 0,
    dryRunCount: dry.n ?? 0,
    dryRunCostUsd: dry.c
  }
}

/** GROUP BY detail for one tool (or prefix), effective calls only (denied/cancelled excluded). */
function countsFor(db: DatabaseSync, where: string, bind: string[]): Map<string, CountRow> {
  const rows = db
    .prepare(
      `SELECT detail, COUNT(*) AS n, MAX(created_at) AS last
       FROM tool_calls
       WHERE detail IS NOT NULL AND decision NOT IN ('denied','cancelled') AND ${where}
       GROUP BY detail`
    )
    .all(...bind) as unknown as CountRow[]
  return new Map(rows.map((r) => [r.detail, r]))
}

export function usageStats(deps: UsageStatsDeps): UsageStatsPayload {
  const now = deps.now?.() ?? new Date()

  // — skills: current resolution ∪ historically activated names —
  const skillCounts = countsFor(deps.db, `tool = 'Skill'`, [])
  const resolved = resolveSkills(deps.argusHome, deps.access)
  const skills: SkillUsageRow[] = resolved.map((s) => ({
    name: s.name,
    tier: s.tier,
    enabled: s.enabled,
    activationCount: skillCounts.get(s.name)?.n ?? 0,
    lastActivatedAt: skillCounts.get(s.name)?.last ?? null
  }))
  const resolvedNames = new Set(resolved.map((s) => s.name))
  for (const [name, row] of skillCounts) {
    if (resolvedNames.has(name)) continue
    skills.push({
      name,
      tier: null,
      enabled: false,
      activationCount: row.n,
      lastActivatedAt: row.last
    })
  }

  // — memory: live topics joined with read_memory recalls —
  const recalls = countsFor(deps.db, `tool = 'mcp__argus__read_memory'`, [])
  const memory = listTopics(deps.argusHome).map((t) => {
    const r = recalls.get(t.name)
    const usage = {
      lastRecalledAt: r?.last ?? null,
      lastWrittenAt: t.lastWritten,
      recallCount: r?.n ?? 0
    }
    return {
      topic: t.name,
      ...usage,
      staleCandidate: isStaleCandidate(usage, deps.hygiene, now)
    }
  })

  // — references: files on disk joined with attributed fs-reads —
  const refReads = countsFor(deps.db, `detail LIKE 'ref:%'`, [])
  const references = listReferenceFiles(sharedReferencesDir(deps.argusHome)).map((relPath) => {
    const r = refReads.get(`ref:${relPath}`)
    return { relPath, readCount: r?.n ?? 0, lastReadAt: r?.last ?? null }
  })

  return {
    hygiene: deps.hygiene,
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    memory,
    references,
    archived: listArchivedTopics(deps.argusHome),
    distillation: distillationStats(deps.db, deps.since)
  }
}
