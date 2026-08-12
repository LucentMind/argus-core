import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { Zip } from 'zip-lib'
import { PackUpdatesService, type HttpClient, type HttpResponse } from '../packUpdates'
import { PacksStateStore } from '../packsState'
import { installPack } from '../install'
import { packsDir } from '../paths'

// Real bundles, real installPack, real inspectBundleSource — only the network is faked. The
// point of this file is that the update-apply path itself refuses an unsatisfied dependency;
// a fake installer would prove nothing about that.
const HOST = { platform: 'win32', arch: 'x64' }
const PLATFORM = 'win-x64'
const FEED_URL = 'https://vendor.example/feed.json'
const BUNDLE_URL = 'https://vendor.example/navigation-0.6.0-win-x64.zip'

let home: string
let state: PacksStateStore

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-depupd-')))
  state = new PacksStateStore(home)
})
afterEach(() => {
  state.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function makeBundleDir(over: Record<string, unknown>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-depbundle-')))
  const manifest = { displayName: 'Pack', argusApi: '^1.1', platform: PLATFORM, ...over }
  fs.writeFileSync(path.join(dir, 'argus-pack.json'), JSON.stringify(manifest, null, 2) + '\n')
  const body = fs.readFileSync(path.join(dir, 'argus-pack.json'))
  const sum = crypto.createHash('sha256').update(body).digest('hex')
  fs.writeFileSync(path.join(dir, 'CHECKSUMS'), `${sum}  argus-pack.json\n`)
  return dir
}

async function zipOf(dir: string): Promise<string> {
  const zip = new Zip()
  for (const name of fs.readdirSync(dir)) zip.addFile(path.join(dir, name), name)
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-depzip-')), 'pack.zip')
  await zip.archive(out)
  return out
}

function http(routes: Record<string, Buffer>): HttpClient {
  const respond = (url: string): HttpResponse => {
    const body = routes[url]
    if (!body) throw new Error(`unexpected fetch: ${url}`)
    return { status: 200, location: null, body }
  }
  return {
    get: async (url) => respond(url),
    getToFile: async (url, destPath) => {
      const r = respond(url)
      fs.writeFileSync(destPath, r.body)
      return {
        status: 200,
        location: null,
        sha256: crypto.createHash('sha256').update(r.body).digest('hex'),
        bytesWritten: r.body.length
      }
    }
  }
}

function feedBody(
  sha256: string,
  over: { id?: string; version?: string; url?: string } = {}
): Buffer {
  const { id = 'navigation', version = '0.6.0', url = BUNDLE_URL } = over
  return Buffer.from(
    JSON.stringify({
      id,
      versions: [{ version, argusApi: '^1.1', platform: PLATFORM, url, sha256 }]
    })
  )
}

describe('applying an update whose new version adds a dependency', () => {
  /** navigation 0.5.0 installed and pinned to the vendor feed; 0.6.0 published, needing common. */
  async function seed(): Promise<HttpClient> {
    const installed = await installPack(
      makeBundleDir({ id: 'navigation', version: '0.5.0', updateUrl: FEED_URL }),
      { argusHome: home, state, host: HOST }
    )
    expect(installed.ok).toBe(true)

    const zipPath = await zipOf(
      makeBundleDir({
        id: 'navigation',
        version: '0.6.0',
        updateUrl: FEED_URL,
        dependencies: { common: '^0.1.0' }
      })
    )
    const bytes = fs.readFileSync(zipPath)
    return http({
      [FEED_URL]: feedBody(crypto.createHash('sha256').update(bytes).digest('hex')),
      [BUNDLE_URL]: bytes
    })
  }

  function svc(client: HttpClient): PackUpdatesService {
    return new PackUpdatesService({ argusHome: home, state, http: client, host: HOST })
  }

  it('holds the update and names the missing dependency, leaving 0.5.0 active', async () => {
    const status = await svc(await seed()).apply('navigation')

    expect(status).toMatchObject({ phase: 'error' })
    expect(status.phase === 'error' ? status.message : '').toContain('common')
    expect(status.phase === 'error' ? status.message : '').toContain('^0.1.0')
    expect(state.get('navigation')).toBe('0.5.0')
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(packsDir(home), 'navigation', 'argus-pack.json'), 'utf8')
    )
    expect(onDisk.version).toBe('0.5.0')
  })

  it('applies the same update once the dependency is installed', async () => {
    const client = await seed()
    const common = await installPack(makeBundleDir({ id: 'common', version: '0.1.2' }), {
      argusHome: home,
      state,
      host: HOST
    })
    expect(common.ok).toBe(true)

    expect(await svc(client).apply('navigation')).toEqual({ phase: 'ready', version: '0.6.0' })
    expect(state.get('navigation')).toBe('0.6.0')
  })
})

describe('applying an update to a pack other packs depend on', () => {
  const COMMON_FEED = 'https://vendor.example/common-feed.json'
  const COMMON_BUNDLE = 'https://vendor.example/common-1.0.0-win-x64.zip'

  /**
   * common 0.1.2 installed and feed-pinned, with navigation requiring it at ^0.1.0. The vendor
   * then publishes common 1.0.0 — a major that navigation's range cannot accept.
   */
  async function seed(publishedVersion: string): Promise<HttpClient> {
    const common = await installPack(
      makeBundleDir({ id: 'common', version: '0.1.2', updateUrl: COMMON_FEED }),
      { argusHome: home, state, host: HOST }
    )
    expect(common.ok).toBe(true)

    const nav = await installPack(
      makeBundleDir({ id: 'navigation', version: '0.5.0', dependencies: { common: '^0.1.0' } }),
      { argusHome: home, state, host: HOST }
    )
    expect(nav.ok).toBe(true)

    const zipPath = await zipOf(
      makeBundleDir({ id: 'common', version: publishedVersion, updateUrl: COMMON_FEED })
    )
    const bytes = fs.readFileSync(zipPath)
    return http({
      [COMMON_FEED]: feedBody(crypto.createHash('sha256').update(bytes).digest('hex'), {
        id: 'common',
        version: publishedVersion,
        url: COMMON_BUNDLE
      }),
      [COMMON_BUNDLE]: bytes
    })
  }

  function svc(client: HttpClient): PackUpdatesService {
    return new PackUpdatesService({ argusHome: home, state, http: client, host: HOST })
  }

  it('holds an update that would break an installed dependent, leaving the old version active', async () => {
    const status = await svc(await seed('1.0.0')).apply('common')

    expect(status).toMatchObject({ phase: 'error' })
    const msg = status.phase === 'error' ? status.message : ''
    expect(msg).toContain('navigation')
    expect(msg).toContain('^0.1.0')

    expect(state.get('common')).toBe('0.1.2')
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(packsDir(home), 'common', 'argus-pack.json'), 'utf8')
    )
    expect(onDisk.version).toBe('0.1.2')
  })

  it('applies an update that stays inside every dependent range', async () => {
    expect(await svc(await seed('0.1.9')).apply('common')).toEqual({
      phase: 'ready',
      version: '0.1.9'
    })
    expect(state.get('common')).toBe('0.1.9')
  })
})
