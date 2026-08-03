import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listRepoPacks, installFromRepo } from '../githubInstall'
import type { installPack } from '../install'
import { GhError, type GhClient } from '../ghClient'
import type { InspectResult, InstallResult } from '../../../../shared/packs'

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

describe('installFromRepo', () => {
  it('installs and pins to the repo the bytes came from, overriding a manifest feed URL', async () => {
    const argusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ghinstall-'))
    const install = vi.fn<typeof installPack>(
      async () =>
        ({
          ok: true,
          id: 'sample-bridge-playground',
          version: '0.1.0',
          previousVersion: null,
          relaunchRequired: true
        }) as InstallResult
    )
    const res = await installFromRepo(
      {
        gh: gh(),
        host: WIN,
        argusHome,
        state: { get: () => undefined } as never,
        install,
        inspectBundleSource: async () =>
          ({
            id: 'sample-bridge-playground',
            version: '0.1.0',
            apiCompatible: true,
            platformCompatible: true,
            updateUrl: 'https://lucentmind.github.io/demo_pack/x/feed.json'
          }) as InspectResult
      },
      REF,
      'sample-bridge-playground'
    )
    expect(res.ok).toBe(true)
    const pin = install.mock.calls[0][1].pinOverride
    expect(pin).toMatchObject({ kind: 'github', owner: 'LucentMind', repo: 'demo_pack' })
    expect(pin).toHaveProperty('manifestPath', 'packs/sample-bridge-playground/argus-pack.json')
  })

  it('pins the canonical repo name, not the one the user typed', async () => {
    const argusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ghinstall-'))
    const client = gh()
    const original = client.api
    // The user types an OLD name; GitHub answers, and reports the new one.
    client.api = async (ref, p) =>
      p === 'repos/OldOrg/demo_pack'
        ? { full_name: 'LucentMind/demo_pack' }
        : original(ref, p.replace('OldOrg', 'LucentMind'))
    const install = vi.fn<typeof installPack>(
      async () =>
        ({
          ok: true,
          id: 'sample-bridge-playground',
          version: '0.1.0',
          previousVersion: null,
          relaunchRequired: true
        }) as InstallResult
    )
    await installFromRepo(
      {
        gh: client,
        host: WIN,
        argusHome,
        state: { get: () => undefined } as never,
        install,
        inspectBundleSource: async () =>
          ({
            id: 'sample-bridge-playground',
            version: '0.1.0',
            apiCompatible: true,
            platformCompatible: true
          }) as InspectResult
      },
      { host: 'github.com', owner: 'OldOrg', repo: 'demo_pack' },
      'sample-bridge-playground'
    )
    // Pinning the typed name would make the very next check report the pack as "moved".
    expect(install.mock.calls[0][1].pinOverride).toMatchObject({ owner: 'LucentMind' })
  })

  it('refuses a bundle that names a different repo as its update home', async () => {
    const argusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ghinstall-'))
    const install = vi.fn()
    const res = await installFromRepo(
      {
        gh: gh(),
        host: WIN,
        argusHome,
        state: { get: () => undefined } as never,
        install: install as never,
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
      'sample-bridge-playground'
    )
    expect(res).toMatchObject({ ok: false, code: 'manifest' })
    expect(install).not.toHaveBeenCalled()
  })

  it('refuses when the downloaded bytes do not match the published digest', async () => {
    const argusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ghinstall-'))
    const client = gh()
    client.downloadAsset = async (_r, _t, _n, dest) => {
      fs.writeFileSync(dest, Buffer.from('tampered'))
      return { sha256: 'b'.repeat(64), bytesWritten: 8 }
    }
    const res = await installFromRepo(
      { gh: client, host: WIN, argusHome, state: { get: () => undefined } as never },
      REF,
      'sample-bridge-playground'
    )
    expect(res).toMatchObject({ ok: false, code: 'checksum' })
  })

  it('refuses to install when the canonical repo name cannot be resolved', async () => {
    const argusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ghinstall-'))
    const client = gh()
    const original = client.api
    client.api = async (ref, p) =>
      p === 'repos/LucentMind/demo_pack'
        ? { full_name: 'this is not a repo name' }
        : original(ref, p)
    const install = vi.fn()
    const res = await installFromRepo(
      {
        gh: client,
        host: WIN,
        argusHome,
        state: { get: () => undefined } as never,
        install: install as never
      },
      REF,
      'sample-bridge-playground'
    )
    expect(res.ok).toBe(false)
    // Falling back to the typed ref here would pin a name GitHub never confirmed.
    expect(install).not.toHaveBeenCalled()
  })
})
