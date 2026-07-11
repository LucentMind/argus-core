import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RefSyncService } from '../refSync/service'
import { ReferenceSyncStore, readSyncState } from '../referenceSyncStore'
import { refTier, parseRefSources } from '../refSync/refFrontmatter'
import { sharedReferencesDir } from '../skillsDir'
import { DEFAULT_ROUTING_RULES } from '../../../shared/referenceSync'
import type { ConfluenceReader } from '../refSync/engine'
import type { ConfluencePageNode } from '../../../shared/confluence'

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
    title: 'Valhalla request tuning',
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
    routingRules: DEFAULT_ROUTING_RULES
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
