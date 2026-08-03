import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PacksStateStore, isGithubSource } from '../packsState'
import { packsStatePath } from '../../paths'

let home: string
let store: PacksStateStore
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pstate-'))
  store = new PacksStateStore(home)
})
afterEach(() => {
  store.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('PacksStateStore', () => {
  it('starts empty', () => {
    expect(store.list()).toEqual({})
    expect(store.get('navigation')).toBeUndefined()
  })

  it('sets and reads id -> version, persisting under config/packs-state.json', () => {
    store.set('navigation', '1.4.0')
    expect(store.get('navigation')).toBe('1.4.0')
    expect(store.list()).toEqual({ navigation: '1.4.0' })
    const onDisk = JSON.parse(fs.readFileSync(packsStatePath(home), 'utf8'))
    expect(onDisk.packs.navigation).toBe('1.4.0')
  })

  it('overwrites a version and removes an id', () => {
    store.set('navigation', '1.4.0')
    store.set('navigation', '1.5.0')
    expect(store.get('navigation')).toBe('1.5.0')
    store.remove('navigation')
    expect(store.get('navigation')).toBeUndefined()
    expect(store.list()).toEqual({})
  })

  it('reads state written by a previous instance', () => {
    store.set('code-graph', '0.1.0')
    store.close()
    const reopened = new PacksStateStore(home)
    expect(reopened.get('code-graph')).toBe('0.1.0')
    reopened.close()
  })
})

describe('pack sources (the origin pin)', () => {
  it('defaults to an empty map for a state file written before sources existed', () => {
    // A pre-Increment-2 file has only `packs`. Reading must not throw or invent entries.
    fs.mkdirSync(path.dirname(packsStatePath(home)), { recursive: true })
    fs.writeFileSync(packsStatePath(home), JSON.stringify({ packs: { alpha: '1.0.0' } }))
    const s = new PacksStateStore(home)
    expect(s.listSources()).toEqual({})
    expect(s.get('alpha')).toBe('1.0.0')
  })

  it('round-trips a source and leaves the versions map untouched', () => {
    const state = new PacksStateStore(home)
    state.set('alpha', '1.0.0')
    state.setSource('alpha', {
      origin: 'https://vendor.example',
      updateUrl: 'https://vendor.example/feed.json',
      installedAt: 111
    })
    const reopened = new PacksStateStore(home)
    expect(reopened.getSource('alpha')).toEqual({
      origin: 'https://vendor.example',
      updateUrl: 'https://vendor.example/feed.json',
      installedAt: 111
    })
    expect(reopened.get('alpha')).toBe('1.0.0')
  })

  it('setSource(id, null) clears the pin', () => {
    const state = new PacksStateStore(home)
    state.setSource('alpha', {
      origin: 'https://vendor.example',
      updateUrl: 'https://vendor.example/feed.json',
      installedAt: 111
    })
    state.setSource('alpha', null)
    expect(new PacksStateStore(home).getSource('alpha')).toBeUndefined()
  })

  it('remove() clears the version AND the pin, so an uninstalled pack leaves no provenance', () => {
    const state = new PacksStateStore(home)
    state.set('alpha', '1.0.0')
    state.setSource('alpha', {
      origin: 'https://vendor.example',
      updateUrl: 'https://vendor.example/feed.json',
      installedAt: 111
    })
    state.remove('alpha')
    const reopened = new PacksStateStore(home)
    expect(reopened.get('alpha')).toBeUndefined()
    expect(reopened.getSource('alpha')).toBeUndefined()
  })

  it('round-trips a github source and reads a pre-union feed pin unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-state-'))
    const store = new PacksStateStore(dir)
    store.set('gh-pack', '1.0.0')
    store.setSource('gh-pack', {
      kind: 'github',
      host: 'github.com',
      owner: 'LucentMind',
      repo: 'demo_pack',
      manifestPath: 'packs/gh-pack/argus-pack.json',
      installedAt: 1
    })
    store.set('feed-pack', '1.0.0')
    store.setSource('feed-pack', {
      origin: 'https://vendor.example',
      updateUrl: 'https://vendor.example/feed.json',
      installedAt: 2
    })
    store.close()

    const reopened = new PacksStateStore(dir)
    const gh = reopened.getSource('gh-pack')
    const feed = reopened.getSource('feed-pack')
    // A pin written before the union existed has NO `kind` — it must still read as a feed pin,
    // which is the whole reason `kind` is optional on the feed arm rather than required.
    expect(feed && isGithubSource(feed)).toBe(false)
    expect(gh && isGithubSource(gh)).toBe(true)
    expect(gh).toMatchObject({ owner: 'LucentMind', repo: 'demo_pack' })
    reopened.close()
  })
})
