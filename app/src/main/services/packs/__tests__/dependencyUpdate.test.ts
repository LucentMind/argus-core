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

function feedBody(sha256: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: 'navigation',
      versions: [
        { version: '0.6.0', argusApi: '^1.1', platform: PLATFORM, url: BUNDLE_URL, sha256 }
      ]
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
