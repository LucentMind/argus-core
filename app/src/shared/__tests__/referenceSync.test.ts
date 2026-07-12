import { describe, it, expect } from 'vitest'
import {
  referenceSyncSchema,
  defaultReferenceSync,
  pageSelected,
  toggleSelection,
  routeTarget,
  isStale,
  isOutdated,
  missingMustKeep,
  type RoutingRule,
  type SpaceConfig
} from '../referenceSync'

// Generic fixture standing in for pack-supplied routing rules (no longer a
// referenceSync.ts export — see packs/manifest.ts `referenceRouting`).
const TEST_ROUTING_RULES: RoutingRule[] = [
  { keywords: ['applog', 'log', 'tag', 'signal'], target: 'log-patterns.md' },
  { keywords: ['tile', 'vector tile', 'datasets', 'dataset version'], target: 'data-versioning.md' }
]

const space = (over: Partial<SpaceConfig> = {}): SpaceConfig => ({
  key: 'NAVNATIVE',
  name: 'Nav Native',
  homepageId: 'root',
  includeRoots: [],
  excludedSubtrees: [],
  routingRules: [],
  ...over
})

describe('schema', () => {
  it('defaults per spec §3.3 and round-trips unknown keys', () => {
    const c = defaultReferenceSync()
    expect(c.spaces).toEqual([])
    expect(c.outdatedWindowMonths).toBe(12)
    expect(c.mustKeep).toEqual({})
    const parsed = referenceSyncSchema.parse({ spaces: [{ key: 'X' }], future: 1 })
    expect(parsed.spaces[0].includeRoots).toEqual([])
    expect((parsed as Record<string, unknown>).future).toBe(1)
  })
})

describe('selection semantics (include roots minus excluded subtrees)', () => {
  it('nearest marker wins; absent markers mean unselected', () => {
    const s = space({ includeRoots: ['root'], excludedSubtrees: ['b'] })
    expect(pageSelected(s, 'root', [])).toBe(true)
    expect(pageSelected(s, 'a1', ['a', 'root'])).toBe(true) // new page under an included node → picked up
    expect(pageSelected(s, 'b', ['root'])).toBe(false)
    expect(pageSelected(s, 'b1', ['b', 'root'])).toBe(false) // exclusions hold
    expect(pageSelected(space(), 'x', [])).toBe(false)
  })

  it('a deeper include root re-includes inside an excluded subtree', () => {
    const s = space({ includeRoots: ['root', 'b2'], excludedSubtrees: ['b'] })
    expect(pageSelected(s, 'b2', ['b', 'root'])).toBe(true)
    expect(pageSelected(s, 'b2x', ['b2', 'b', 'root'])).toBe(true)
  })

  it('toggle off a root removes it; toggle off an inherited node excludes it', () => {
    const s = space({ includeRoots: ['root'] })
    expect(toggleSelection(s, 'root', []).includeRoots).toEqual([])
    expect(toggleSelection(s, 'a', ['root']).excludedSubtrees).toEqual(['a'])
  })

  it('toggle on clears a stale exclusion and adds a root only when needed', () => {
    const s = space({ includeRoots: ['root'], excludedSubtrees: ['a'] })
    const on = toggleSelection(s, 'a', ['root'])
    expect(on.excludedSubtrees).toEqual([])
    expect(on.includeRoots).toEqual(['root']) // ancestor already covers it
    const lone = toggleSelection(space(), 'a', ['root'])
    expect(lone.includeRoots).toEqual(['a'])
  })
})

describe('routing', () => {
  it('first matching rule wins, case-insensitive substring on title', () => {
    expect(routeTarget('App log tag cheat-sheet', TEST_ROUTING_RULES)).toBe('log-patterns.md')
    expect(routeTarget('Vector Tile datasets', TEST_ROUTING_RULES)).toBe('data-versioning.md')
    expect(routeTarget('Quarterly planning', TEST_ROUTING_RULES)).toBeNull() // unrouted
  })

  it('rejects a matching rule whose target is a path traversal or the generated index (falls to unrouted)', () => {
    const traversal = [{ keywords: ['routing'], target: '../../../evil.md' }]
    expect(routeTarget('Routing deep dive', traversal)).toBeNull()
    const indexTarget = [{ keywords: ['routing'], target: 'INDEX.md' }]
    expect(routeTarget('Routing deep dive', indexTarget)).toBeNull()
    const normal = [{ keywords: ['routing'], target: 'routing-flow.md' }]
    expect(routeTarget('Routing deep dive', normal)).toBe('routing-flow.md')
  })
})

describe('staleness', () => {
  const now = new Date('2026-07-10T00:00:00Z')
  it('stale after 14 days unsynced or never synced', () => {
    expect(isStale(null, now)).toBe(true)
    expect(isStale('2026-07-01T00:00:00Z', now)).toBe(false)
    expect(isStale('2026-06-01T00:00:00Z', now)).toBe(true)
  })
  it('outdated badge after the configured window', () => {
    expect(isOutdated('2025-01-01T00:00:00Z', 12, now)).toBe(true)
    expect(isOutdated('2026-06-01T00:00:00Z', 12, now)).toBe(false)
    expect(isOutdated(null, 12, now)).toBe(false)
  })
})

describe('must-keep guard', () => {
  it('reports verbatim patterns missing from a distilled body (case-sensitive)', () => {
    expect(
      missingMustKeep('kept `E/TileStore` intact', ['E/TileStore', 'BLOCKED_VERSION'])
    ).toEqual(['BLOCKED_VERSION'])
    expect(missingMustKeep('anything', [])).toEqual([])
    expect(missingMustKeep('e/tilestore lowercased', ['E/TileStore'])).toEqual(['E/TileStore'])
  })
})
