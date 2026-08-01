import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { buildFeed } from '../src/feed'

let dir: string
let packDir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedtest-'))
  packDir = path.join(dir, 'pack')
  fs.mkdirSync(packDir)
  fs.writeFileSync(
    path.join(packDir, 'argus-pack.json'),
    JSON.stringify({ id: 'sample', displayName: 'Sample', version: '1.1.0', argusApi: '^1' })
  )
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function bundle(name: string, body: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, body)
  return p
}

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')

describe('buildFeed', () => {
  it('takes id and argusApi from the manifest, version and platform from the filename', () => {
    const feed = buildFeed({
      packDir,
      bundles: [bundle('sample-1.1.0-win-x64.zip', 'zipbytes')],
      baseUrl: 'https://vendor.example/packs'
    })
    expect(feed).toEqual({
      id: 'sample',
      versions: [
        {
          version: '1.1.0',
          argusApi: '^1',
          platform: 'win-x64',
          url: 'https://vendor.example/packs/sample-1.1.0-win-x64.zip',
          sha256: sha('zipbytes')
        }
      ]
    })
  })

  it('joins the base URL without doubling or dropping a slash', () => {
    const feed = buildFeed({
      packDir,
      bundles: [bundle('sample-1.1.0-win-x64.zip', 'x')],
      baseUrl: 'https://v.example/p/'
    })
    expect(feed.versions[0].url).toBe('https://v.example/p/sample-1.1.0-win-x64.zip')
  })

  it('collects several platforms of the same version', () => {
    const feed = buildFeed({
      packDir,
      bundles: [
        bundle('sample-1.1.0-win-x64.zip', 'a'),
        bundle('sample-1.1.0-mac-arm64.zip', 'b')
      ],
      baseUrl: 'https://v.example'
    })
    expect(feed.versions.map((v) => v.platform).sort()).toEqual(['mac-arm64', 'win-x64'])
    expect(feed.versions.find((v) => v.platform === 'mac-arm64')!.sha256).toBe(sha('b'))
  })

  it('refuses a bundle belonging to a different pack than the manifest', () => {
    expect(() =>
      buildFeed({
        packDir,
        bundles: [bundle('other-1.0.0-win-x64.zip', 'a')],
        baseUrl: 'https://v.example'
      })
    ).toThrow(/does not belong to pack 'sample'/)
  })

  it('rejects a filename that is not <id>-<version>-<os>-<arch>.zip', () => {
    expect(() =>
      buildFeed({ packDir, bundles: [bundle('garbage.zip', 'a')], baseUrl: 'https://v.example' })
    ).toThrow(/filename/)
  })

  it('rejects a non-https base URL — Core refuses to fetch one', () => {
    expect(() =>
      buildFeed({
        packDir,
        bundles: [bundle('sample-1.1.0-win-x64.zip', 'a')],
        baseUrl: 'http://v.example'
      })
    ).toThrow(/https/)
  })

  it('rejects an empty bundle list rather than emitting a feed offering nothing', () => {
    expect(() => buildFeed({ packDir, bundles: [], baseUrl: 'https://v.example' })).toThrow(
      /no bundles/
    )
  })

  it('refuses a bundle whose pack id is a hyphen-extension of the manifest id', () => {
    // 'sample-extra' is a DIFFERENT pack from 'sample', but its bundle name starts with
    // 'sample-', so the naive startsWith(`${manifest.id}-`) guard would accept it and slice
    // out 'extra-1.0.0' as the "version" — a nonsense string that is not valid semver.
    expect(() =>
      buildFeed({
        packDir,
        bundles: [bundle('sample-extra-1.0.0-win-x64.zip', 'a')],
        baseUrl: 'https://v.example'
      })
    ).toThrow(/does not belong to pack 'sample'/)
  })

  it('parses a hyphenated pack id and a prerelease version correctly', () => {
    // A generic <id>-<version>-<os>-<arch> regex mis-splits both of these and silently
    // publishes the wrong version string, which the feed then advertises as installable.
    fs.writeFileSync(
      path.join(packDir, 'argus-pack.json'),
      JSON.stringify({
        id: 'code-graph',
        displayName: 'Code Graph',
        version: '1.1.0-beta.1',
        argusApi: '^1'
      })
    )
    const feed = buildFeed({
      packDir,
      bundles: [bundle('code-graph-1.1.0-beta.1-win-x64.zip', 'a')],
      baseUrl: 'https://v.example'
    })
    expect(feed.id).toBe('code-graph')
    expect(feed.versions[0].version).toBe('1.1.0-beta.1')
    expect(feed.versions[0].platform).toBe('win-x64')
  })
})
