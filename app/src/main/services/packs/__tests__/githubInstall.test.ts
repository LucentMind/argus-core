import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listRepoPacks, stageRepoBundle } from '../githubInstall'
import { GhError, type GhClient } from '../ghClient'
import type { InspectResult } from '../../../../shared/packs'

const WIN = { platform: 'win32', arch: 'x64' }
const REF = { host: 'github.com', owner: 'LucentMind', repo: 'demo_pack' }
const SHA = 'a'.repeat(64)
const BYTES = Buffer.from('pretend this is a zip')

function asset(name: string): Record<string, unknown> {
  return {
    name,
    size: BYTES.length,
    digest: `sha256:${SHA}`,
    browser_download_url: `https://github.com/LucentMind/demo_pack/releases/download/v0.1.0/${name}`
  }
}

function gh(over: Partial<Record<string, unknown>> = {}): GhClient {
  const routes: Record<string, unknown> = {
    'repos/LucentMind/demo_pack/releases': [
      {
        tag_name: 'v0.1.0',
        draft: false,
        prerelease: false,
        html_url: 'https://github.com/LucentMind/demo_pack/releases/tag/v0.1.0',
        assets: [
          asset('sample-bridge-playground-0.1.0-win-x64.zip'),
          asset('sample-external-app-0.1.0-win-x64.zip')
        ]
      }
    ],
    'repos/LucentMind/demo_pack/git/trees': {
      tree: [
        { path: 'packs/sample-bridge-playground/argus-pack.json', type: 'blob' },
        { path: 'packs/sample-external-app/argus-pack.json', type: 'blob' }
      ]
    },
    ...over
  }
  return {
    api: async (_ref, p) => {
      // Exact match first: the bare repo path is a PREFIX of every other route.
      if (p === 'repos/LucentMind/demo_pack') return { full_name: 'LucentMind/demo_pack' }
      if (p.includes('/contents/')) {
        const id = p.includes('sample-external-app')
          ? 'sample-external-app'
          : 'sample-bridge-playground'
        return {
          content: Buffer.from(JSON.stringify({ id, version: '0.1.0', argusApi: '^1' })).toString(
            'base64'
          )
        }
      }
      const key = Object.keys(routes).find((k) => p.startsWith(k))
      if (!key) throw new GhError('notfound', p)
      return routes[key]
    },
    downloadAsset: async (_ref, _tag, _name, dest) => {
      fs.writeFileSync(dest, BYTES)
      return { sha256: SHA, bytesWritten: BYTES.length }
    }
  }
}

describe('listRepoPacks', () => {
  // demo_pack is one repo publishing two packs under one tag — the layout the tag-derived
  // version scheme would have failed on.
  it('lists every pack the newest release publishes', async () => {
    const rows = await listRepoPacks({ gh: gh(), host: WIN }, REF)
    expect(rows.map((r) => r.id).sort()).toEqual([
      'sample-bridge-playground',
      'sample-external-app'
    ])
    expect(rows.every((r) => r.installable)).toBe(true)
    expect(rows[0].version).toBe('0.1.0')
  })

  it('marks an API-incompatible pack uninstallable with a reason rather than hiding it', async () => {
    const client = gh()
    const original = client.api
    client.api = async (ref, p) =>
      p.includes('/contents/')
        ? {
            content: Buffer.from(
              JSON.stringify({
                id: p.includes('external') ? 'sample-external-app' : 'sample-bridge-playground',
                version: '0.1.0',
                argusApi: '^99'
              })
            ).toString('base64')
          }
        : original(ref, p)
    const rows = await listRepoPacks({ gh: client, host: WIN }, REF)
    expect(rows.every((r) => !r.installable)).toBe(true)
    expect(rows[0].reason).toMatch(/version of Argus/i)
  })

  it('drops only the pack whose manifest is unparseable, not the whole listing', async () => {
    const client = gh()
    const original = client.api
    client.api = async (ref, p) => {
      if (p.includes('/contents/') && p.includes('sample-external-app')) {
        return { content: Buffer.from('{ this is not json').toString('base64') }
      }
      return original(ref, p)
    }
    const rows = await listRepoPacks({ gh: client, host: WIN }, REF)
    // The valid sibling must still be offered — a single broken commit in a multi-pack repo
    // otherwise reads as "this repository publishes nothing".
    expect(rows.map((r) => r.id)).toEqual(['sample-bridge-playground'])
  })
})

describe('stageRepoBundle', () => {
  function dest(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ghstage-'))
  }

  it('stages the bytes and pins the repo they came from, overriding a manifest feed URL', async () => {
    const res = await stageRepoBundle(
      {
        gh: gh(),
        host: WIN,
        inspectBundleSource: async () =>
          ({
            id: 'sample-bridge-playground',
            version: '0.1.0',
            apiCompatible: true,
            platformCompatible: true,
            updateUrl: 'https://lucentmind.github.io/demo_pack/x/feed.json',
            dependencies: [],
            rawDependencies: {}
          }) as InspectResult
      },
      REF,
      'sample-bridge-playground',
      dest()
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.pin).toMatchObject({ kind: 'github', owner: 'LucentMind', repo: 'demo_pack' })
    expect(res.pin).toHaveProperty('manifestPath', 'packs/sample-bridge-playground/argus-pack.json')
    // The bytes must be on disk in the caller's directory: the planner installs from this path.
    expect(fs.existsSync(res.zipPath)).toBe(true)
    expect(path.dirname(res.zipPath)).toMatch(/argus-ghstage-/)
  })

  it('pins the canonical repo name, not the one the user typed', async () => {
    const client = gh()
    const original = client.api
    // The user types an OLD name; GitHub answers, and reports the new one.
    client.api = async (ref, p) =>
      p === 'repos/OldOrg/demo_pack'
        ? { full_name: 'LucentMind/demo_pack' }
        : original(ref, p.replace('OldOrg', 'LucentMind'))
    const res = await stageRepoBundle(
      {
        gh: client,
        host: WIN,
        inspectBundleSource: async () =>
          ({
            id: 'sample-bridge-playground',
            version: '0.1.0',
            apiCompatible: true,
            platformCompatible: true
          }) as InspectResult
      },
      { host: 'github.com', owner: 'OldOrg', repo: 'demo_pack' },
      'sample-bridge-playground',
      dest()
    )
    expect(res.ok).toBe(true)
    // Pinning the typed name would make the very next check report the pack as "moved".
    if (res.ok) expect(res.pin).toMatchObject({ owner: 'LucentMind' })
  })

  it('refuses a bundle that names a different repo as its update home', async () => {
    const res = await stageRepoBundle(
      {
        gh: gh(),
        host: WIN,
        inspectBundleSource: async () =>
          ({
            id: 'sample-bridge-playground',
            version: '0.1.0',
            apiCompatible: true,
            platformCompatible: true,
            updateRepo: 'someone-else/their-pack'
          }) as InspectResult
      },
      REF,
      'sample-bridge-playground',
      dest()
    )
    expect(res).toMatchObject({ ok: false, code: 'manifest' })
  })

  it('refuses when the downloaded bytes do not match the published digest', async () => {
    const client = gh()
    client.downloadAsset = async (_r, _t, _n, d) => {
      fs.writeFileSync(d, Buffer.from('tampered'))
      return { sha256: 'b'.repeat(64), bytesWritten: 8 }
    }
    const res = await stageRepoBundle(
      { gh: client, host: WIN },
      REF,
      'sample-bridge-playground',
      dest()
    )
    expect(res).toMatchObject({ ok: false, code: 'checksum' })
  })

  it('refuses when the canonical repo name cannot be resolved', async () => {
    const client = gh()
    const original = client.api
    client.api = async (ref, p) =>
      p === 'repos/LucentMind/demo_pack'
        ? { full_name: 'this is not a repo name' }
        : original(ref, p)
    const res = await stageRepoBundle(
      { gh: client, host: WIN },
      REF,
      'sample-bridge-playground',
      dest()
    )
    // Falling back to the typed ref here would pin a name GitHub never confirmed.
    expect(res.ok).toBe(false)
  })

  it('refuses a bundle declaring a different pack id than the one asked for', async () => {
    const res = await stageRepoBundle(
      {
        gh: gh(),
        host: WIN,
        inspectBundleSource: async () =>
          ({
            id: 'something-else',
            version: '0.1.0',
            apiCompatible: true,
            platformCompatible: true
          }) as InspectResult
      },
      REF,
      'sample-bridge-playground',
      dest()
    )
    expect(res).toMatchObject({ ok: false, code: 'manifest' })
  })
})
