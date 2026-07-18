import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  walkSelection,
  computeChangedSet,
  referenceStatuses,
  generateReferencesIndex,
  detectVanished,
  type ConfluenceReader
} from '../refSync/engine'
import { stampRefFile } from '../refSync/refFrontmatter'
import type { RoutingRule, SpaceConfig, ReferenceSyncConfig } from '../../../shared/referenceSync'
import type { ConfluencePageNode } from '../../../shared/confluence'

// Fixture standing in for pack-supplied routing rules (moved to
// packs/sample/argus-pack.json `referenceRouting` — see packs/manifest.ts).
const ROUTING_RULES_FIXTURE: RoutingRule[] = [
  { keywords: ['applog', 'log', 'tag', 'signal'], target: 'log-patterns.md' },
  {
    keywords: ['history recording', 'event log', 'worker history', 'telemetry'],
    target: 'recording-schema.md'
  },
  {
    keywords: ['routing', 'directions', 'queue', 'scheduler', 'cache request'],
    target: 'routing-flow.md'
  },
  {
    keywords: ['tile', 'vector tile', 'datasets', 'dataset version'],
    target: 'data-versioning.md'
  },
  { keywords: ['worker', 'pipeline update'], target: 'engine.md' },
  { keywords: ['binlog', 'pipeline', 'event stream', 'binary log'], target: 'protocol.md' },
  { keywords: ['graph', 'dependency graph'], target: 'graph.md' },
  { keywords: ['tool', 'mcp', 'debugging tool'], target: 'tool-selection-guide.md' }
]

// tree: 100 Home ── 101 Routing deep dive ── 104 Cache request tuning
//                ├─ 102 Meeting notes (leaf)
//                └─ 103 Postmortems (has children; excluded)
const NODES: Record<string, ConfluencePageNode> = {
  '100': {
    id: '100',
    title: 'Home',
    version: 1,
    lastModified: '2026-07-01T00:00:00.000Z',
    hasChildren: true
  },
  '101': {
    id: '101',
    title: 'Routing deep dive',
    version: 3,
    lastModified: '2026-07-01T00:00:00.000Z',
    hasChildren: true
  },
  '102': {
    id: '102',
    title: 'Meeting notes',
    version: 2,
    lastModified: '2026-01-01T00:00:00.000Z',
    hasChildren: false
  },
  '103': {
    id: '103',
    title: 'Postmortems',
    version: 5,
    lastModified: '2026-07-01T00:00:00.000Z',
    hasChildren: true
  },
  '104': {
    id: '104',
    title: 'Cache request tuning',
    version: 7,
    lastModified: '2026-07-05T00:00:00.000Z',
    hasChildren: false
  }
}
const CHILDREN: Record<string, string[]> = {
  '100': ['101', '102', '103'],
  '101': ['104'],
  '103': ['999']
}

function fakeReader(log: string[]): ConfluenceReader {
  return {
    getConfluenceSpace: async (key) => {
      log.push(`space:${key}`)
      return { key, name: key, homepageId: '100' }
    },
    getConfluencePage: async (id) => {
      log.push(`page:${id}`)
      return NODES[id]
    },
    getConfluenceChildren: async (id) => {
      log.push(`children:${id}`)
      return (CHILDREN[id] ?? []).map((c) => NODES[c])
    },
    getConfluencePageContent: async (id) => {
      log.push(`content:${id}`)
      return { node: NODES[id], url: `https://x/wiki/${id}`, markdown: `md of ${id}` }
    }
  }
}

const space: SpaceConfig = {
  key: 'NAVNATIVE',
  name: 'Nav Native',
  homepageId: '100',
  includeRoots: ['100'],
  excludedSubtrees: ['103'],
  routingRules: ROUTING_RULES_FIXTURE
}

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-eng-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('walkSelection', () => {
  it('collects included pages and NEVER fetches excluded subtrees', async () => {
    const log: string[] = []
    const pages = await walkSelection(fakeReader(log), space)
    expect(pages.map((p) => p.id).sort()).toEqual(['100', '101', '102', '104'])
    expect(log).not.toContain('children:103')
    expect(log.filter((l) => l.startsWith('content:'))).toEqual([]) // metadata only, no bodies
    const p104 = pages.find((p) => p.id === '104')!
    expect(p104.ancestorIds).toEqual(['101', '100']) // nearest-first
  })

  it('a nested include root under an exclusion re-includes its subtree', async () => {
    const log: string[] = []
    const s = { ...space, includeRoots: ['100', '999'], excludedSubtrees: ['103'] }
    NODES['999'] = {
      id: '999',
      title: 'Tile datasets',
      version: 1,
      lastModified: null,
      hasChildren: false
    }
    const pages = await walkSelection(fakeReader(log), s)
    expect(pages.map((p) => p.id)).toContain('999')
    expect(log).not.toContain('children:103')
  })
})

describe('computeChangedSet', () => {
  it('routes by title, reports unrouted, and diffs versions against frontmatter sources', async () => {
    const pages = await walkSelection(fakeReader([]), space)
    // routing-flow.md already has 101@v3 synced; 104 is new → only 104 is dirty
    fs.writeFileSync(
      path.join(tmp, 'routing-flow.md'),
      stampRefFile('# Routing\n', {
        title: 'Routing flow',
        sources: [{ url: 'u', pageId: '101', version: 3, lastSynced: '2026-07-01T00:00:00.000Z' }],
        now: new Date('2026-07-01T00:00:00Z')
      })
    )
    const cs = computeChangedSet(pages, space, tmp)
    expect(cs.unrouted.map((p) => p.id).sort()).toEqual(['100', '102']) // no keyword match → surfaced, not dropped
    expect(cs.changed).toEqual([
      { target: 'routing-flow.md', pages: [expect.objectContaining({ id: '104' })] }
    ])
  })

  it('team-knowledge / hivemind targets become conflicts and are skipped', async () => {
    const pages = await walkSelection(fakeReader([]), space)
    fs.writeFileSync(
      path.join(tmp, 'routing-flow.md'),
      '---\ntrust_tier: team-knowledge\n---\n# hand-written\n'
    )
    const cs = computeChangedSet(pages, space, tmp)
    expect(cs.changed).toEqual([])
    expect(cs.conflicts).toEqual([{ target: 'routing-flow.md', tier: 'team-knowledge' }])
  })

  it('a missing target file means every routed page is dirty', async () => {
    const pages = await walkSelection(fakeReader([]), space)
    const cs = computeChangedSet(pages, space, tmp)
    expect(cs.changed[0].pages.map((p) => p.id).sort()).toEqual(['101', '104'])
  })
})

describe('referenceStatuses', () => {
  it('reports tier, newest last_synced and the 14-day staleness badge; skips INDEX.md', () => {
    fs.writeFileSync(
      path.join(tmp, 'routing-flow.md'),
      stampRefFile('# R\n', {
        title: 'R',
        sources: [{ url: 'u', pageId: '101', version: 3, lastSynced: '2026-06-01T00:00:00.000Z' }],
        now: new Date('2026-06-01T00:00:00Z')
      })
    )
    fs.writeFileSync(path.join(tmp, 'glossary.md'), '---\ntrust_tier: team-knowledge\n---\nx')
    fs.writeFileSync(path.join(tmp, 'INDEX.md'), '# References index\n')
    const now = new Date('2026-07-10T00:00:00Z')
    const st = referenceStatuses(tmp, now)
    expect(st).toEqual([
      {
        file: 'glossary.md',
        tier: 'team-knowledge',
        lastSynced: null,
        sourceCount: 0,
        stale: false
      },
      {
        file: 'routing-flow.md',
        tier: 'confluence',
        lastSynced: '2026-06-01T00:00:00.000Z',
        sourceCount: 1,
        stale: true
      }
    ])
  })
})

describe('generateReferencesIndex', () => {
  it('one line per file: title, first-paragraph summary, routing keywords; excludes itself', () => {
    fs.writeFileSync(
      path.join(tmp, 'routing-flow.md'),
      stampRefFile(
        '# Routing flow\n\nHow a route request travels from the SDK to the engine.\n\n## Detail\n',
        {
          title: 'Routing flow',
          sources: [
            { url: 'u', pageId: '101', version: 3, lastSynced: '2026-07-01T00:00:00.000Z' }
          ],
          now: new Date('2026-07-01T00:00:00Z')
        }
      )
    )
    fs.writeFileSync(
      path.join(tmp, 'glossary.md'),
      '---\ntitle: Glossary\ntrust_tier: team-knowledge\n---\n# Glossary\n\nTerms used across references.\n'
    )
    fs.writeFileSync(path.join(tmp, 'INDEX.md'), 'stale generated content')
    const config: ReferenceSyncConfig = {
      spaces: [space],
      outdatedWindowMonths: 12,
      mustKeep: {}
    }
    const idx = generateReferencesIndex(tmp, config)
    expect(idx).toContain('<!-- generated by reference-sync — do not edit -->')
    expect(idx).toContain(
      '- [Routing flow](routing-flow.md) — How a route request travels from the SDK to the engine.'
    )
    expect(idx).toContain('keywords: routing, directions')
    expect(idx).toContain('- [Glossary](glossary.md) — Terms used across references.')
    expect(idx).not.toContain('](INDEX.md')
  })
})

describe('detectVanished', () => {
  const src = (
    pageId: string
  ): { url: string; pageId: string; version: number; lastSynced: string } => ({
    url: `https://c/${pageId}`,
    pageId,
    version: 1,
    lastSynced: '2026-06-01T00:00:00.000Z'
  })
  const write = (name: string, pageIds: string[]): void => {
    fs.writeFileSync(
      path.join(tmp, name),
      stampRefFile('# R\n', {
        title: 'R',
        sources: pageIds.map(src),
        now: new Date('2026-06-01T00:00:00Z')
      })
    )
  }
  const seen = (
    ids: Record<string, string>
  ): Record<string, { version: number; lastModified: string | null; title?: string }> =>
    Object.fromEntries(
      Object.entries(ids).map(([id, title]) => [id, { version: 1, lastModified: null, title }])
    )

  it('flags a file whose every source disappeared as orphaned', () => {
    write('routing-flow.md', ['101'])
    const v = detectVanished(tmp, seen({ '101': 'Routing flow' }), new Set())
    expect(v).toEqual([
      {
        target: 'routing-flow.md',
        pages: [{ pageId: '101', title: 'Routing flow' }],
        orphaned: true
      }
    ])
  })

  it('flags a partially-affected file as NOT orphaned — surviving pages still justify it', () => {
    write('routing-flow.md', ['101', '102'])
    const v = detectVanished(tmp, seen({ '101': 'Gone', '102': 'Still here' }), new Set(['102']))
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ orphaned: false })
    expect(v[0].pages).toEqual([{ pageId: '101', title: 'Gone' }])
  })

  it('reports nothing when every previously-seen page is still selected', () => {
    write('routing-flow.md', ['101'])
    expect(detectVanished(tmp, seen({ '101': 'Routing flow' }), new Set(['101']))).toEqual([])
  })

  it('never offers a hand-owned (team-knowledge) file for pruning', () => {
    fs.writeFileSync(
      path.join(tmp, 'glossary.md'),
      '---\ntrust_tier: team-knowledge\nsources:\n  - page_id: "101"\n---\nx'
    )
    expect(detectVanished(tmp, seen({ '101': 'Gone' }), new Set())).toEqual([])
  })

  it('falls back to the page id when no title was recorded (pre-upgrade state)', () => {
    write('routing-flow.md', ['101'])
    const v = detectVanished(tmp, { '101': { version: 1, lastModified: null } }, new Set())
    expect(v[0].pages[0].title).toBe('101')
  })
})
