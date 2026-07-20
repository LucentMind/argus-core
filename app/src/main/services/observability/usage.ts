import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AppSettings } from '../../../shared/settings'
import type { AgentAccess } from '../../../shared/agentAccess'
import type { UsageStatsPayload, SkillUsageRow } from '../../../shared/observability'
import { REFERENCES_INDEX } from '../../../shared/referenceSync'
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

/** Every *.md under the references dir (recursive), relPath with forward slashes,
 *  excluding the generated INDEX.md router. */
function listReferenceFiles(refsDir: string): string[] {
  if (!fs.existsSync(refsDir)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) {
        const rel = path.relative(refsDir, p).split(path.sep).join('/')
        if (rel !== REFERENCES_INDEX) out.push(rel)
      }
    }
  }
  walk(refsDir)
  return out.sort()
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
    archived: listArchivedTopics(deps.argusHome)
  }
}
