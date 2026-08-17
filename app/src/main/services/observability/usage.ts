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
}

/** Rollup over completed case distill jobs. `COUNT(*)` counts every done `kind='case'` row
 *  regardless of whether it recorded usage (pre-v2 rows didn't); `SUM`/`AVG` are SQLite
 *  aggregates, which skip NULL inputs on their own — so a pre-v2 done row lowers no average, and
 *  an all-pre-v2 history reports a real jobCount with every average staying null rather than 0. */
function distillationStats(db: DatabaseSync): DistillationUsageStats {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(cost_usd) AS total_cost,
              AVG(cost_usd) AS avg_cost,
              AVG(prompt_chars) AS avg_prompt,
              AVG(turn_count) AS avg_turn
       FROM distill_jobs
       WHERE kind = 'case' AND state = 'done'`
    )
    .get() as unknown as DistillationRow
  return {
    jobCount: row.n,
    totalCostUsd: row.total_cost,
    avgCostUsd: row.avg_cost,
    avgPromptChars: row.avg_prompt,
    avgTurnCount: row.avg_turn
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
    distillation: distillationStats(deps.db)
  }
}
