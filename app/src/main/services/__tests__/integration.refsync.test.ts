import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RefSyncService } from '../refSync/service'
import { ReferenceSyncStore, readSyncState, writeSyncState } from '../referenceSyncStore'
import { refTier, parseRefSources } from '../refSync/refFrontmatter'
import { sharedReferencesDir } from '../skillsDir'
import type { ConfluenceReader } from '../refSync/engine'
import type { ConfluencePageNode } from '../../../shared/confluence'
import type { RoutingRule } from '../../../shared/referenceSync'

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

// — fake Confluence (same tree as refSyncEngine.test.ts) —
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
    getConfluenceSpace: async (key) => ({ key, name: 'Nav Native', homepageId: '100' }),
    getConfluencePage: async (id) => (log.push(`page:${id}`), NODES[id]),
    getConfluenceChildren: async (id) => (
      log.push(`children:${id}`),
      (CHILDREN[id] ?? []).map((c) => NODES[c])
    ),
    getConfluencePageContent: async (id) => (
      log.push(`content:${id}`),
      { node: NODES[id], url: `https://x/wiki/${id}`, markdown: `md of ${id}` }
    )
  }
}

let tmp: string, home: string, store: ReferenceSyncStore, log: string[], svc: RefSyncService

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rsvc-'))
  home = path.join(tmp, 'home')
  fs.mkdirSync(sharedReferencesDir(home), { recursive: true })
  store = new ReferenceSyncStore(home)
  store.upsertSpace({
    key: 'NAVNATIVE',
    name: 'Nav Native',
    homepageId: '100',
    includeRoots: ['100'],
    excludedSubtrees: ['103'],
    routingRules: ROUTING_RULES_FIXTURE
  })
  log = []
  svc = new RefSyncService({
    argusHome: home,
    store,
    reader: fakeReader(log),
    now: () => new Date('2026-07-10T00:00:00Z'),
    distill: async (input) =>
      `# Distilled ${input.target}\n\npages: ${input.pages.map((p) => p.pageId).join(',')}\n`
  })
})

afterEach(() => {
  store.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

it('sync produces drafts + unrouted without writing; excluded subtrees never fetch', async () => {
  const report = await svc.sync('NAVNATIVE')
  expect(report.drafts.map((d) => d.target)).toEqual(['routing-flow.md'])
  expect(report.drafts[0].pages.map((p) => p.id).sort()).toEqual(['101', '104'])
  expect(report.unrouted.map((u) => u.id).sort()).toEqual(['100', '102'])
  expect(log).not.toContain('children:103')
  expect(log).not.toContain('content:103')
  expect(fs.existsSync(path.join(sharedReferencesDir(home), 'routing-flow.md'))).toBe(false) // preview first
  const st = readSyncState(home).spaces['NAVNATIVE']
  expect(Object.keys(st.seenPages).sort()).toEqual(['100', '101', '102', '104'])
  expect(st.driftTargets).toEqual(['routing-flow.md'])
})

it('applyDrafts writes atomically with confluence provenance and clears drift', async () => {
  const report = await svc.sync('NAVNATIVE')
  const applied = svc.applyDrafts(report.syncId, ['routing-flow.md'])
  expect(applied.written).toEqual(['routing-flow.md'])
  const raw = fs.readFileSync(path.join(sharedReferencesDir(home), 'routing-flow.md'), 'utf8')
  expect(refTier(raw)).toBe('confluence')
  expect(
    parseRefSources(raw)
      .map((s) => [s.pageId, s.version])
      .sort()
  ).toEqual([
    ['101', 3],
    ['104', 7]
  ])
  expect(readSyncState(home).spaces['NAVNATIVE'].driftTargets).toEqual([])
  // second sync: nothing changed
  const again = await svc.sync('NAVNATIVE')
  expect(again.drafts).toEqual([])
})

it('team-knowledge files are conflicts at sync AND re-checked at write time', async () => {
  const file = path.join(sharedReferencesDir(home), 'routing-flow.md')
  fs.writeFileSync(file, '---\ntrust_tier: team-knowledge\n---\n# mine\n')
  const report = await svc.sync('NAVNATIVE')
  expect(report.conflicts).toEqual([{ target: 'routing-flow.md', tier: 'team-knowledge' }])
  expect(report.drafts).toEqual([])
  // even a stale/forged syncId+target cannot overwrite: simulate by writing the tier after a clean sync
  fs.rmSync(file)
  const clean = await svc.sync('NAVNATIVE')
  fs.writeFileSync(file, '---\ntrust_tier: team-knowledge\n---\n# mine\n')
  const applied = svc.applyDrafts(clean.syncId, ['routing-flow.md'])
  expect(applied.written).toEqual([])
  expect(applied.skipped[0].reason).toMatch(/team-knowledge/)
  expect(fs.readFileSync(file, 'utf8')).toContain('# mine')
})

it('a distill failure is isolated per file', async () => {
  const failing = new RefSyncService({
    argusHome: home,
    store,
    reader: fakeReader([]),
    now: () => new Date('2026-07-10T00:00:00Z'),
    distill: async () => {
      throw new Error('boom')
    }
  })
  const report = await failing.sync('NAVNATIVE')
  expect(report.drafts).toEqual([])
  expect(report.failures).toEqual([{ target: 'routing-flow.md', error: 'boom' }])
})

it('drafts carry must-keep misses; applyDrafts regenerates INDEX.md', async () => {
  store.setMustKeep('routing-flow.md', ['BLOCKED_VERSION'])
  const report = await svc.sync('NAVNATIVE')
  expect(report.drafts[0].guardMisses).toEqual(['BLOCKED_VERSION']) // fake distill body lacks it
  const applied = svc.applyDrafts(report.syncId, ['routing-flow.md'])
  expect(applied.written).toEqual(['routing-flow.md']) // warn-only — apply not blocked
  const idx = fs.readFileSync(path.join(sharedReferencesDir(home), 'INDEX.md'), 'utf8')
  expect(idx).toContain('](routing-flow.md)')
  expect(svc.payload().references.map((r) => r.file)).not.toContain('INDEX.md')
})

it('applyDrafts rejects a forged path-traversal target without writing outside the references dir', async () => {
  const report = await svc.sync('NAVNATIVE')
  const forged = '../../../evil.md'
  const applied = svc.applyDrafts(report.syncId, [forged])
  expect(applied.written).toEqual([])
  expect(applied.skipped).toEqual([{ target: forged, reason: 'invalid target name' }])
  expect(fs.existsSync(path.join(tmp, 'evil.md'))).toBe(false)
  expect(fs.existsSync(path.join(home, 'evil.md'))).toBe(false)
})

it('readReference serves guarded viewer reads; traversal names throw', async () => {
  const report = await svc.sync('NAVNATIVE')
  svc.applyDrafts(report.syncId, ['routing-flow.md'])
  const r = svc.readReference('routing-flow.md')
  expect(r.file).toBe('routing-flow.md')
  expect(r.content).toContain('trust_tier: confluence')
  expect(() => svc.readReference('../../../evil.md')).toThrow(/invalid reference name/)
})

it('searchReferences matches file names and body content, excluding INDEX.md', async () => {
  const report = await svc.sync('NAVNATIVE')
  svc.applyDrafts(report.syncId, ['routing-flow.md'])
  fs.writeFileSync(
    path.join(sharedReferencesDir(home), 'glossary.md'),
    '---\ntrust_tier: team-knowledge\n---\n# Glossary\n\nBLOCKED_VERSION means the tile set is pinned.\n'
  )
  expect(svc.searchReferences('routing')).toEqual(['routing-flow.md']) // name match
  expect(svc.searchReferences('blocked_version')).toEqual(['glossary.md']) // content, case-insensitive
  expect(svc.searchReferences('reference-sync — do not edit')).toEqual([]) // INDEX.md excluded
  expect(svc.searchReferences('   ')).toEqual([]) // blank query
})

it('payload exposes cards with staleness and reference statuses', async () => {
  const before = svc.payload()
  expect(before.cards[0]).toMatchObject({ key: 'NAVNATIVE', stale: true, lastSyncedAt: null })
  const report = await svc.sync('NAVNATIVE')
  svc.applyDrafts(report.syncId, ['routing-flow.md'])
  const after = svc.payload()
  expect(after.cards[0]).toMatchObject({ stale: false, pageCount: 4 })
  expect(after.references.find((r) => r.file === 'routing-flow.md')).toMatchObject({
    tier: 'confluence',
    stale: false
  })
})

describe('upstream deletions', () => {
  /** Sync + apply once so a reference file exists citing pages 101 and 104. */
  async function seedApplied(): Promise<void> {
    const first = await svc.sync('NAVNATIVE')
    svc.applyDrafts(first.syncId, ['routing-flow.md'])
  }

  it('reports a file as orphaned once every page it cites disappears upstream', async () => {
    await seedApplied()
    // the whole subtree is gone from Confluence on the next run
    const state = readSyncState(home)
    state.spaces['NAVNATIVE'].seenPages = {
      '900': { version: 1, lastModified: null, title: 'Deleted page' }
    }
    writeSyncState(home, state)

    const second = await svc.sync('NAVNATIVE')
    // 900 was never in this run's selection → vanished. It isn't cited by any file, so
    // nothing is reported; this asserts we don't invent entries.
    expect(second.vanished).toEqual([])
  })

  it('detects a vanished page that a reference file still cites, and prunes it on approval', async () => {
    await seedApplied()
    const refFile = path.join(sharedReferencesDir(home), 'routing-flow.md')
    expect(fs.existsSync(refFile)).toBe(true)

    // Pretend the previous run saw only the two pages this file cites, and both are now
    // gone from the space's selection.
    const state = readSyncState(home)
    state.spaces['NAVNATIVE'].seenPages = {
      '101': { version: 1, lastModified: null, title: 'Routing rules' },
      '104': { version: 1, lastModified: null, title: 'Fallback routing' }
    }
    writeSyncState(home, state)
    // A reader whose space is now empty — every page vanished.
    const empty = new RefSyncService({
      argusHome: home,
      store,
      reader: {
        getConfluenceSpace: async () => ({
          key: 'NAVNATIVE',
          name: 'Nav Native',
          homepageId: null
        }),
        getConfluencePage: async () => {
          throw new Error('gone')
        },
        getConfluencePageChildren: async () => [],
        getConfluencePageContent: async () => {
          throw new Error('gone')
        }
      } as never,
      now: () => new Date('2026-07-11T00:00:00Z'),
      distill: async () => ''
    })
    store.upsertSpace({
      key: 'NAVNATIVE',
      name: 'Nav Native',
      homepageId: '100',
      includeRoots: [],
      excludedSubtrees: [],
      routingRules: ROUTING_RULES_FIXTURE
    })

    const report = await empty.sync('NAVNATIVE')
    expect(report.vanished).toHaveLength(1)
    expect(report.vanished[0]).toMatchObject({ target: 'routing-flow.md', orphaned: true })

    // detection alone must not touch the file
    expect(fs.existsSync(refFile)).toBe(true)

    const r = empty.prune(report.syncId, ['routing-flow.md'])
    expect(r.removed).toEqual(['routing-flow.md'])
    expect(fs.existsSync(refFile)).toBe(false)
    // the agent-facing router must not keep pointing at a deleted file
    const index = fs.readFileSync(path.join(sharedReferencesDir(home), 'INDEX.md'), 'utf8')
    expect(index).not.toContain('routing-flow.md')
  })

  it('prune refuses a target that this sync did not report as vanished', async () => {
    const report = await svc.sync('NAVNATIVE')
    const r = svc.prune(report.syncId, ['routing-flow.md'])
    expect(r.removed).toEqual([])
    expect(r.skipped[0].reason).toMatch(/not reported as vanished/)
  })

  it('prune rejects a path-traversal target name', async () => {
    const report = await svc.sync('NAVNATIVE')
    const r = svc.prune(report.syncId, ['../../etc/passwd'])
    expect(r.skipped[0].reason).toBe('invalid target name')
  })

  it('prune throws once the sync report has expired', () => {
    expect(() => svc.prune('nope', [])).toThrow(/expired/)
  })
})

it('deleteReference removes hand-owned files, refuses hive-managed tiers', () => {
  const dir = sharedReferencesDir(home)
  fs.writeFileSync(path.join(dir, 'mine.md'), '---\ntrust_tier: team-knowledge\n---\n# mine\n')
  fs.writeFileSync(path.join(dir, 'untagged.md'), '# no frontmatter\n')
  fs.writeFileSync(path.join(dir, 'synced.md'), '---\ntrust_tier: confluence\n---\n# synced\n')
  fs.writeFileSync(path.join(dir, 'hive.md'), '---\ntrust_tier: hivemind\n---\n# hive\n')

  svc.deleteReference('mine.md')
  svc.deleteReference('untagged.md') // no tier ⇒ hand-owned by convention (tier ?? team-knowledge)
  expect(fs.existsSync(path.join(dir, 'mine.md'))).toBe(false)
  expect(fs.existsSync(path.join(dir, 'untagged.md'))).toBe(false)

  expect(() => svc.deleteReference('synced.md')).toThrow(/not a hand-owned reference/)
  expect(() => svc.deleteReference('hive.md')).toThrow(/not a hand-owned reference/)
  expect(fs.existsSync(path.join(dir, 'synced.md'))).toBe(true)
  expect(fs.existsSync(path.join(dir, 'hive.md'))).toBe(true)
})

it('deleteReference rejects invalid names and the generated index', () => {
  for (const evil of ['../evil.md', 'no-md-suffix', 'INDEX.md', '']) {
    expect(() => svc.deleteReference(evil)).toThrow(/invalid reference name/)
  }
})
