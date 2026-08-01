import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { Zip } from 'zip-lib'
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

/** Writes plain (non-zip) bytes at `name` — enough for the filename/id checks, which run
 *  BEFORE the bundle is ever opened as a zip. */
function bundle(name: string, body: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, body)
  return p
}

/**
 * Builds a REAL zip at `name` containing an `argus-pack.json` with the given manifest fields —
 * required now that `buildFeed` reads `argusApi` out of each bundle's own manifest (Fix 3).
 * `body` pads the zip's compressed content so bundles that must produce distinct sha256 values
 * (but carry the same manifest) don't collide.
 */
async function zipBundle(
  name: string,
  manifest: { id?: string; displayName?: string; version?: string; argusApi: string },
  body = ''
): Promise<string> {
  const stageDir = fs.mkdtempSync(path.join(dir, 'stage-'))
  const manifestPath = path.join(stageDir, 'argus-pack.json')
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      id: manifest.id ?? 'sample',
      displayName: manifest.displayName ?? 'Sample',
      version: manifest.version ?? '1.1.0',
      argusApi: manifest.argusApi
    })
  )
  if (body) fs.writeFileSync(path.join(stageDir, 'padding.txt'), body)
  const zipPath = path.join(dir, name)
  const zip = new Zip()
  zip.addFile(manifestPath, 'argus-pack.json')
  if (body) zip.addFile(path.join(stageDir, 'padding.txt'), 'padding.txt')
  await zip.archive(zipPath)
  return zipPath
}

const shaOfFile = (p: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

describe('buildFeed', () => {
  it('takes id from the manifest, version and platform from the filename, argusApi from the BUNDLE (Fix 3)', async () => {
    const bundlePath = await zipBundle('sample-1.1.0-win-x64.zip', { argusApi: '^1' })
    const feed = await buildFeed({
      packDir,
      bundles: [bundlePath],
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
          sha256: shaOfFile(bundlePath)
        }
      ]
    })
  })

  it('reads a DIFFERENT argusApi per bundle rather than stamping every entry with the source manifest', async () => {
    // The load-bearing case for Fix 3: the source manifest here declares argusApi '^1' (see
    // beforeEach), but a vendor may keep publishing an older bundle built against argusApi '^1'
    // alongside a newer one built against '^2'. Stamping both with whatever the CURRENT source
    // manifest says would relabel the older bundle and strand ^1-Core users who could otherwise
    // still get it.
    const older = await zipBundle(
      'sample-1.1.0-win-x64.zip',
      { version: '1.1.0', argusApi: '^1' },
      'older'
    )
    const newer = await zipBundle(
      'sample-2.0.0-win-x64.zip',
      { version: '2.0.0', argusApi: '^2' },
      'newer'
    )
    const feed = await buildFeed({
      packDir,
      bundles: [older, newer],
      baseUrl: 'https://v.example'
    })
    const byVersion = Object.fromEntries(feed.versions.map((v) => [v.version, v.argusApi]))
    expect(byVersion).toEqual({ '1.1.0': '^1', '2.0.0': '^2' })
  })

  it('fails with a clear error naming the bundle when it has no readable manifest inside', async () => {
    // A bundle that isn't a zip at all — the filename checks pass (this only needs to LOOK like
    // a bundle name), but there is nothing to unzip.
    const notAZip = bundle('sample-1.1.0-win-x64.zip', 'not actually a zip file')
    await expect(
      buildFeed({ packDir, bundles: [notAZip], baseUrl: 'https://v.example' })
    ).rejects.toThrow(/sample-1\.1\.0-win-x64\.zip/)
  })

  it('fails with a clear error naming the bundle when the zip has no argus-pack.json inside', async () => {
    const stageDir = fs.mkdtempSync(path.join(dir, 'stage-'))
    fs.writeFileSync(path.join(stageDir, 'readme.txt'), 'no manifest here')
    const zipPath = path.join(dir, 'sample-1.1.0-win-x64.zip')
    const zip = new Zip()
    zip.addFile(path.join(stageDir, 'readme.txt'), 'readme.txt')
    await zip.archive(zipPath)

    await expect(
      buildFeed({ packDir, bundles: [zipPath], baseUrl: 'https://v.example' })
    ).rejects.toThrow(/sample-1\.1\.0-win-x64\.zip.*no argus-pack\.json/s)
  })

  it('sorts versions by semver descending (Fix 6i)', async () => {
    const b110 = await zipBundle(
      'sample-1.1.0-win-x64.zip',
      { version: '1.1.0', argusApi: '^1' },
      'a'
    )
    const b300 = await zipBundle(
      'sample-3.0.0-win-x64.zip',
      { version: '3.0.0', argusApi: '^1' },
      'b'
    )
    const b200 = await zipBundle(
      'sample-2.0.0-win-x64.zip',
      { version: '2.0.0', argusApi: '^1' },
      'c'
    )
    const feed = await buildFeed({
      packDir,
      bundles: [b110, b300, b200],
      baseUrl: 'https://v.example'
    })
    expect(feed.versions.map((v) => v.version)).toEqual(['3.0.0', '2.0.0', '1.1.0'])
  })

  it('joins the base URL without doubling or dropping a slash', async () => {
    const bundlePath = await zipBundle('sample-1.1.0-win-x64.zip', { argusApi: '^1' })
    const feed = await buildFeed({
      packDir,
      bundles: [bundlePath],
      baseUrl: 'https://v.example/p/'
    })
    expect(feed.versions[0].url).toBe('https://v.example/p/sample-1.1.0-win-x64.zip')
  })

  it('collects several platforms of the same version', async () => {
    const win = await zipBundle('sample-1.1.0-win-x64.zip', { argusApi: '^1' }, 'a')
    const mac = await zipBundle('sample-1.1.0-mac-arm64.zip', { argusApi: '^1' }, 'b')
    const feed = await buildFeed({
      packDir,
      bundles: [win, mac],
      baseUrl: 'https://v.example'
    })
    expect(feed.versions.map((v) => v.platform).sort()).toEqual(['mac-arm64', 'win-x64'])
    expect(feed.versions.find((v) => v.platform === 'mac-arm64')!.sha256).toBe(shaOfFile(mac))
  })

  it('refuses a bundle belonging to a different pack than the manifest', async () => {
    await expect(
      buildFeed({
        packDir,
        bundles: [bundle('other-1.0.0-win-x64.zip', 'a')],
        baseUrl: 'https://v.example'
      })
    ).rejects.toThrow(/does not belong to pack 'sample'/)
  })

  it('rejects a filename that is not <id>-<version>-<os>-<arch>.zip', async () => {
    await expect(
      buildFeed({ packDir, bundles: [bundle('garbage.zip', 'a')], baseUrl: 'https://v.example' })
    ).rejects.toThrow(/filename/)
  })

  it('rejects a non-https base URL — Core refuses to fetch one', async () => {
    await expect(
      buildFeed({
        packDir,
        bundles: [bundle('sample-1.1.0-win-x64.zip', 'a')],
        baseUrl: 'http://v.example'
      })
    ).rejects.toThrow(/https/)
  })

  it('rejects a malformed base URL rather than a confusing origin-pin error downstream (Fix 6h)', async () => {
    await expect(
      buildFeed({
        packDir,
        bundles: [bundle('sample-1.1.0-win-x64.zip', 'a')],
        baseUrl: 'https://not a valid url'
      })
    ).rejects.toThrow(/not a valid URL/)
  })

  it('rejects an empty bundle list rather than emitting a feed offering nothing', async () => {
    await expect(buildFeed({ packDir, bundles: [], baseUrl: 'https://v.example' })).rejects.toThrow(
      /no bundles/
    )
  })

  it('refuses a bundle whose pack id is a hyphen-extension of the manifest id', async () => {
    // 'sample-extra' is a DIFFERENT pack from 'sample', but its bundle name starts with
    // 'sample-', so the naive startsWith(`${manifest.id}-`) guard would accept it and slice
    // out 'extra-1.0.0' as the "version" — a nonsense string that is not valid semver.
    await expect(
      buildFeed({
        packDir,
        bundles: [bundle('sample-extra-1.0.0-win-x64.zip', 'a')],
        baseUrl: 'https://v.example'
      })
    ).rejects.toThrow(/does not belong to pack 'sample'/)
  })

  it("fails naming the bundle when its manifest id disagrees with its own filename (Minor c)", async () => {
    // The filename/packDir checks earlier only look at the STRING id embedded in the filename —
    // they never open the zip. A bundle built from a stale or mislabeled source dir can carry a
    // manifest whose `id` disagrees with that, and `app/.../packUpdates.ts apply()` treats that
    // mismatch as fatal for every user at update time. Catch it here, at publish time, instead.
    const bundlePath = await zipBundle('sample-1.1.0-win-x64.zip', {
      id: 'not-sample',
      argusApi: '^1'
    })
    await expect(
      buildFeed({ packDir, bundles: [bundlePath], baseUrl: 'https://v.example' })
    ).rejects.toThrow(/sample-1\.1\.0-win-x64\.zip.*declares pack id 'not-sample'/s)
  })

  it('fails naming the bundle when its manifest version disagrees with its own filename (Minor c)', async () => {
    const bundlePath = await zipBundle('sample-1.1.0-win-x64.zip', {
      version: '9.9.9',
      argusApi: '^1'
    })
    await expect(
      buildFeed({ packDir, bundles: [bundlePath], baseUrl: 'https://v.example' })
    ).rejects.toThrow(/sample-1\.1\.0-win-x64\.zip.*declares version '9\.9\.9'/s)
  })

  it('parses a hyphenated pack id and a prerelease version correctly', async () => {
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
    const bundlePath = await zipBundle('code-graph-1.1.0-beta.1-win-x64.zip', {
      id: 'code-graph',
      version: '1.1.0-beta.1',
      argusApi: '^1'
    })
    const feed = await buildFeed({
      packDir,
      bundles: [bundlePath],
      baseUrl: 'https://v.example'
    })
    expect(feed.id).toBe('code-graph')
    expect(feed.versions[0].version).toBe('1.1.0-beta.1')
    expect(feed.versions[0].platform).toBe('win-x64')
  })
})
