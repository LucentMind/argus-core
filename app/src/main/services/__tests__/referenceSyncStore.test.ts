import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReferenceSyncStore, readSyncState, writeSyncState } from '../referenceSyncStore'
import { refSyncPath } from '../paths'
import { DEFAULT_ROUTING_RULES, emptySpaceState } from '../../../shared/referenceSync'

let tmp: string, home: string, store: ReferenceSyncStore

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rss-'))
  home = path.join(tmp, 'home')
  store = new ReferenceSyncStore(home)
})

afterEach(() => {
  store.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

it('starts with defaults and round-trips a space (full write, arrays intact)', () => {
  expect(store.get().spaces).toEqual([])
  store.upsertSpace({
    key: 'NAVNATIVE',
    name: 'Nav Native',
    homepageId: '100',
    includeRoots: ['100'],
    excludedSubtrees: ['b'],
    routingRules: DEFAULT_ROUTING_RULES
  })
  const onDisk = JSON.parse(fs.readFileSync(refSyncPath(home), 'utf8'))
  expect(onDisk.spaces[0].excludedSubtrees).toEqual(['b'])
  const again = new ReferenceSyncStore(home)
  expect(again.get().spaces[0].includeRoots).toEqual(['100'])
  again.close()
})

it('upsert replaces by key; removeSpace drops it', () => {
  store.upsertSpace({ key: 'A', includeRoots: ['1'] })
  store.upsertSpace({ key: 'A', includeRoots: ['2'] })
  expect(store.get().spaces).toHaveLength(1)
  expect(store.get().spaces[0].includeRoots).toEqual(['2'])
  store.removeSpace('A')
  expect(store.get().spaces).toEqual([])
})

it('setMustKeep round-trips per target', () => {
  store.setMustKeep('routing-flow.md', ['E/TileStore', 'BLOCKED_VERSION'])
  expect(store.get().mustKeep['routing-flow.md']).toEqual(['E/TileStore', 'BLOCKED_VERSION'])
  const again = new ReferenceSyncStore(home)
  expect(again.get().mustKeep['routing-flow.md']).toEqual(['E/TileStore', 'BLOCKED_VERSION'])
  again.close()
})

it('broken json → defaults + loadError; explicit save clears it', () => {
  fs.mkdirSync(path.dirname(refSyncPath(home)), { recursive: true })
  fs.writeFileSync(refSyncPath(home), '{nope')
  const broken = new ReferenceSyncStore(home)
  expect(broken.loadError()).toBeTruthy()
  expect(broken.get().outdatedWindowMonths).toBe(12)
  broken.setOutdatedWindow(6)
  expect(broken.loadError()).toBeNull()
  broken.close()
})

it('sync state round-trips and defaults when absent', () => {
  expect(readSyncState(home)).toEqual({ spaces: {} })
  const s = {
    spaces: { NAVNATIVE: { ...emptySpaceState(), lastSyncedAt: '2026-07-10T00:00:00Z' } }
  }
  writeSyncState(home, s)
  expect(readSyncState(home)).toEqual(s)
})
