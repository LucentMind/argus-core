import { z } from 'zod'
import type { ConfluencePageNode } from './confluence'

/**
 * config/reference-sync.json (spec §3.3) — the routing/selection contract.
 * Selection persists as include-roots minus excluded-subtrees: pages appearing
 * later under an included node are picked up by default; exclusions hold.
 */
export const routingRuleSchema = z.looseObject({
  keywords: z.array(z.string()).default(() => []),
  target: z.string()
})
export type RoutingRule = z.infer<typeof routingRuleSchema>

export const spaceConfigSchema = z.looseObject({
  key: z.string(),
  name: z.string().default(''),
  homepageId: z.string().default(''),
  includeRoots: z.array(z.string()).default(() => []),
  excludedSubtrees: z.array(z.string()).default(() => []),
  routingRules: z.array(routingRuleSchema).default(() => [])
})
export type SpaceConfig = z.infer<typeof spaceConfigSchema>

export const referenceSyncSchema = z.looseObject({
  spaces: z.array(spaceConfigSchema).default(() => []),
  outdatedWindowMonths: z.number().default(12),
  /**
   * Must-keep guard (amendment): target file → verbatim signal patterns (log
   * tags, error strings) that every distilled draft of that file must contain.
   * Misses are warn-only flags in the sync report — apply is never blocked.
   */
  mustKeep: z.record(z.string(), z.array(z.string())).default(() => ({}))
})
export type ReferenceSyncConfig = z.infer<typeof referenceSyncSchema>

export function defaultReferenceSync(): ReferenceSyncConfig {
  return referenceSyncSchema.parse({})
}

/** Migrated verbatim from references/confluence-pages.md ("Page → reference file mapping"). */
export const DEFAULT_ROUTING_RULES: RoutingRule[] = [
  { keywords: ['applog', 'log', 'tag', 'signal'], target: 'log-patterns.md' },
  {
    keywords: ['history recording', 'rec', 'navigator history', 'telemetry'],
    target: 'recording-schema.md'
  },
  {
    keywords: ['routing', 'directions', 'parallel hybrid', 'graph hopper', 'valhalla request'],
    target: 'routing-flow.md'
  },
  {
    keywords: ['tile', 'vector tile', 'datasets', 'dataset version'],
    target: 'data-versioning.md'
  },
  { keywords: ['valhalla', 'routing engine update'], target: 'valhalla-runbook.md' },
  { keywords: ['binlog', 'automotive', 'OEM-A binlog', 'bintrace'], target: 'binlog-protocol.md' },
  { keywords: ['adasis', 'electronic horizon'], target: 'adasis.md' },
  { keywords: ['tool', 'mcp', 'debugging tool'], target: 'tool-selection-guide.md' }
]

export const STALE_AFTER_DAYS = 14

/** Generated router file in the references dir — never a distill target, never listed in statuses. */
export const REFERENCES_INDEX = 'INDEX.md'

/**
 * Nearest marker (self first, then ancestors nearest-first) wins; an exclusion
 * on a node beats an include on the same node; no marker anywhere = unselected.
 */
export function pageSelected(space: SpaceConfig, pageId: string, ancestorIds: string[]): boolean {
  for (const id of [pageId, ...ancestorIds]) {
    if (space.excludedSubtrees.includes(id)) return false
    if (space.includeRoots.includes(id)) return true
  }
  return false
}

/** Pure toggle for the curation tree; ancestorIds nearest-first. */
export function toggleSelection(
  space: SpaceConfig,
  pageId: string,
  ancestorIds: string[]
): SpaceConfig {
  const without = (arr: string[]): string[] => arr.filter((id) => id !== pageId)
  if (pageSelected(space, pageId, ancestorIds)) {
    // turning OFF: an explicit root just disappears; a node selected via an
    // ancestor gets an exclusion marker (exclusions hold across syncs)
    return space.includeRoots.includes(pageId)
      ? { ...space, includeRoots: without(space.includeRoots) }
      : { ...space, excludedSubtrees: [...without(space.excludedSubtrees), pageId] }
  }
  // turning ON: drop a stale exclusion; add a root only if no ancestor covers it
  const next = { ...space, excludedSubtrees: without(space.excludedSubtrees) }
  if (!pageSelected(next, pageId, ancestorIds)) {
    next.includeRoots = [...next.includeRoots, pageId]
  }
  return next
}

/** First matching rule wins (list order = priority); case-insensitive substring on the title. */
export function routeTarget(title: string, rules: RoutingRule[]): string | null {
  const t = title.toLowerCase()
  for (const r of rules) {
    if (r.keywords.some((k) => k && t.includes(k.toLowerCase()))) return r.target
  }
  return null
}

export function isStale(lastSynced: string | null, now: Date): boolean {
  if (!lastSynced) return true
  return now.getTime() - Date.parse(lastSynced) > STALE_AFTER_DAYS * 86_400_000
}

export function isOutdated(lastModified: string | null, windowMonths: number, now: Date): boolean {
  if (!lastModified) return false
  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - windowMonths)
  return Date.parse(lastModified) < cutoff.getTime()
}

/** Case-sensitive substring guard: which must-keep patterns did a draft lose? */
export function missingMustKeep(body: string, patterns: string[]): string[] {
  return patterns.filter((p) => p && !body.includes(p))
}

// — machine state (config/reference-sync.state.json; not user-facing, not watched) —

export interface SpaceSyncState {
  lastSyncedAt: string | null
  /** Page-id → snapshot at the last sync; powers NEW badges. */
  seenPages: Record<string, { version: number; lastModified: string | null }>
  /** Targets known changed but not yet applied (failed or unapproved drafts). */
  driftTargets: string[]
}
export interface RefSyncState {
  spaces: Record<string, SpaceSyncState>
}
export function emptySpaceState(): SpaceSyncState {
  return { lastSyncedAt: null, seenPages: {}, driftTargets: [] }
}

// — cross-process payloads —

export interface SpaceCard {
  key: string
  name: string
  pageCount: number | null
  lastSyncedAt: string | null
  stale: boolean
  driftTargets: string[]
}

export interface ReferenceStatus {
  file: string
  tier: string | null
  lastSynced: string | null
  sourceCount: number
  stale: boolean
}

export interface RefSyncPayload {
  config: ReferenceSyncConfig
  loadError: string | null
  cards: SpaceCard[]
  references: ReferenceStatus[]
}

/** Tree node decorated for the curation UI (checked state is computed client-side). */
export interface TreeNodeVM extends ConfluencePageNode {
  isNew: boolean
  outdated: boolean
}

export interface DraftFile {
  target: string
  oldBody: string | null
  newBody: string
  /** Must-keep patterns absent from newBody (warn-only, rendered in the report). */
  guardMisses: string[]
  pages: Array<{ id: string; title: string; url: string; version: number }>
}

export interface SyncReport {
  syncId: string
  spaceKey: string
  selectedCount: number
  drafts: DraftFile[]
  unrouted: Array<{ id: string; title: string }>
  conflicts: Array<{ target: string; tier: string }>
  failures: Array<{ target: string; error: string }>
}

export interface SyncProgress {
  spaceKey: string
  message: string
}
