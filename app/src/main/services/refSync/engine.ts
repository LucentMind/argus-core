import fs from 'node:fs'
import path from 'node:path'
import type {
  ConfluenceSpace,
  ConfluencePageNode,
  ConfluencePageContent
} from '../../../shared/confluence'
import {
  routeTarget,
  isStale,
  REFERENCES_INDEX,
  type SpaceConfig,
  type ReferenceStatus,
  type ReferenceSyncConfig
} from '../../../shared/referenceSync'
import { refTier, refTitle, refBody, parseRefSources } from './refFrontmatter'

/** Structural subset of AtlassianClient — lets tests inject a fake without HTTP. */
export interface ConfluenceReader {
  getConfluenceSpace(key: string): Promise<ConfluenceSpace>
  getConfluencePage(pageId: string): Promise<ConfluencePageNode>
  getConfluenceChildren(pageId: string): Promise<ConfluencePageNode[]>
  getConfluencePageContent(pageId: string): Promise<ConfluencePageContent>
}

export interface SelectedPage extends ConfluencePageNode {
  /** nearest-first, same convention as shared/referenceSync helpers */
  ancestorIds: string[]
}

/**
 * Deterministic metadata walk of the persisted selection (spec §3.4, no tokens).
 * Descends from each include root; an excluded node is never descended into —
 * excluded subtrees are never fetched (Part 3 exit-check assertion).
 */
export async function walkSelection(
  reader: ConfluenceReader,
  space: SpaceConfig,
  onProgress?: (message: string) => void
): Promise<SelectedPage[]> {
  const out = new Map<string, SelectedPage>()
  for (const rootId of space.includeRoots) {
    if (space.excludedSubtrees.includes(rootId)) continue // exclusion beats include on the same node
    if (out.has(rootId)) continue
    const root = await reader.getConfluencePage(rootId)
    const stack: SelectedPage[] = [{ ...root, ancestorIds: [] }]
    while (stack.length) {
      const node = stack.pop()!
      if (space.excludedSubtrees.includes(node.id)) continue
      if (out.has(node.id)) continue
      out.set(node.id, node)
      if (!node.hasChildren) continue
      onProgress?.(`listing children of "${node.title}"…`)
      const kids = await reader.getConfluenceChildren(node.id)
      for (const k of kids) stack.push({ ...k, ancestorIds: [node.id, ...node.ancestorIds] })
    }
  }
  return [...out.values()]
}

export interface ChangeSet {
  changed: Array<{ target: string; pages: SelectedPage[] }>
  unrouted: SelectedPage[]
  conflicts: Array<{ target: string; tier: string }>
}

/**
 * Groups the selection by routing target and keeps only pages whose version
 * differs from the per-source frontmatter record (spec §3.4). Targets owned by
 * a human (`team-knowledge`) or the HiveMind are conflicts, never overwritten.
 */
export function computeChangedSet(
  selected: SelectedPage[],
  space: SpaceConfig,
  referencesDir: string
): ChangeSet {
  const byTarget = new Map<string, SelectedPage[]>()
  const unrouted: SelectedPage[] = []
  for (const p of selected) {
    const target = routeTarget(p.title, space.routingRules)
    if (!target)
      unrouted.push(p) // surfaced in the sync report — no silent drops (spec §3.3)
    else byTarget.set(target, [...(byTarget.get(target) ?? []), p])
  }
  const changed: ChangeSet['changed'] = []
  const conflicts: ChangeSet['conflicts'] = []
  for (const [target, pages] of byTarget) {
    const file = path.join(referencesDir, target)
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    const tier = raw ? refTier(raw) : null
    if (raw && tier !== 'confluence') {
      conflicts.push({ target, tier: tier ?? 'team-knowledge' })
      continue
    }
    const sources = raw ? parseRefSources(raw) : []
    const dirty = pages.filter((p) => {
      const s = sources.find((x) => x.pageId === p.id)
      return !s || s.version !== p.version
    })
    if (dirty.length) changed.push({ target, pages: dirty })
  }
  return { changed, unrouted, conflicts }
}

/** Per-file staleness for the References page (>14 days unsynced, confluence tier only). */
export function referenceStatuses(referencesDir: string, now: Date): ReferenceStatus[] {
  if (!fs.existsSync(referencesDir)) return []
  return fs
    .readdirSync(referencesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== REFERENCES_INDEX)
    .map((e) => {
      const raw = fs.readFileSync(path.join(referencesDir, e.name), 'utf8')
      const tier = refTier(raw)
      const sources = parseRefSources(raw)
      const newest =
        sources
          .map((s) => s.lastSynced)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null
      return {
        file: e.name,
        tier,
        lastSynced: newest,
        sourceCount: sources.length,
        stale: tier === 'confluence' && isStale(newest, now)
      }
    })
    .sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * Amendment: deterministic one-line-per-file router — progressive disclosure
 * for the agent (read ~2 KB to pick a section instead of opening whole files).
 * Title from frontmatter (filename fallback), summary = first non-heading
 * paragraph line, keywords = reverse routing-rule map. No tokens spent.
 */
export function generateReferencesIndex(
  referencesDir: string,
  config: ReferenceSyncConfig
): string {
  const rules = config.spaces.flatMap((s) => s.routingRules)
  const lines = fs
    .readdirSync(referencesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== REFERENCES_INDEX)
    .map((e) => {
      const raw = fs.readFileSync(path.join(referencesDir, e.name), 'utf8')
      const title = refTitle(raw) ?? e.name.replace(/\.md$/, '')
      const summary =
        refBody(raw)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('#')) ?? ''
      const keywords = [
        ...new Set(rules.filter((r) => r.target === e.name).flatMap((r) => r.keywords))
      ]
      return `- [${title}](${e.name}) — ${summary.slice(0, 160)}${
        keywords.length ? ` · keywords: ${keywords.join(', ')}` : ''
      }`
    })
    .sort()
  return [
    '# References index',
    '<!-- generated by reference-sync — do not edit -->',
    '',
    ...lines,
    ''
  ].join('\n')
}
