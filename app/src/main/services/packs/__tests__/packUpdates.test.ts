import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { PackUpdatesService, type HttpClient, type HttpResponse } from '../packUpdates'
import { PacksStateStore } from '../packsState'
import type { InstallResult } from '../../../../shared/packs'

const WIN = { platform: 'win32', arch: 'x64' }
const ZIP = Buffer.from('pretend this is a zip')
const ZIP_SHA = crypto.createHash('sha256').update(ZIP).digest('hex')

function feedBody(over: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: 'sample',
      versions: [
        {
          version: '1.1.0',
          argusApi: '^1',
          platform: 'win-x64',
          url: 'https://vendor.example/sample-1.1.0-win-x64.zip',
          sha256: ZIP_SHA,
          ...over
        }
      ]
    })
  )
}

const ok = (body: Buffer): HttpResponse => ({ status: 200, location: null, body })

/** Serves the feed and the bundle from a routing table; records every URL requested. */
function http(routes: Record<string, HttpResponse | (() => never)>): HttpClient & {
  urls: string[]
} {
  const urls: string[] = []
  return {
    urls,
    get: async (url) => {
      urls.push(url)
      const r = routes[url]
      if (!r) throw new Error(`unexpected fetch: ${url}`)
      if (typeof r === 'function') return r()
      return r
    }
  }
}

let home: string
let state: PacksStateStore
let install: ReturnType<typeof vi.fn>

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pu-')))
  state = new PacksStateStore(home)
  state.set('sample', '1.0.0')
  state.setSource('sample', {
    origin: 'https://vendor.example',
    updateUrl: 'https://vendor.example/feed.json',
    installedAt: 1
  })
  install = vi.fn(async (): Promise<InstallResult> => ({
    ok: true,
    id: 'sample',
    version: '1.1.0',
    previousVersion: '1.0.0',
    relaunchRequired: true
  }))
})

afterEach(() => {
  state.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function svc(client: HttpClient): PackUpdatesService {
  return new PackUpdatesService({
    argusHome: home,
    state,
    http: client,
    install: install as never,
    host: WIN,
    now: () => 1000
  })
}

describe('checkAll', () => {
  it('reports available for a newer compatible version', async () => {
    const c = http({ 'https://vendor.example/feed.json': ok(feedBody()) })
    expect((await svc(c).checkAll()).sample).toEqual({ phase: 'available', version: '1.1.0' })
  })

  it('fetches the pinned URL verbatim, not a URL rebuilt from the origin', async () => {
    const c = http({ 'https://vendor.example/feed.json': ok(feedBody()) })
    await svc(c).checkAll()
    expect(c.urls).toEqual(['https://vendor.example/feed.json'])
  })

  it('reports idle when nothing newer exists', async () => {
    const c = http({ 'https://vendor.example/feed.json': ok(feedBody({ version: '1.0.0' })) })
    expect((await svc(c).checkAll()).sample).toEqual({ phase: 'idle' })
  })

  it('skips packs with no recorded pin — a seed pack is never checked', async () => {
    state.setSource('sample', null)
    const c = http({})
    expect(await svc(c).checkAll()).toEqual({})
    expect(c.urls).toEqual([])
  })

  it('rejects a feed whose id does not match the installed pack', async () => {
    const body = Buffer.from(JSON.stringify({ id: 'somethingelse', versions: [] }))
    const c = http({ 'https://vendor.example/feed.json': ok(body) })
    const s = (await svc(c).checkAll()).sample
    expect(s.phase).toBe('error')
    expect(s).toMatchObject({ code: 'feed' })
  })

  it('rejects a redirected feed rather than following it', async () => {
    const c = http({
      'https://vendor.example/feed.json': {
        status: 302,
        location: 'https://evil.example/feed.json',
        body: Buffer.alloc(0)
      }
    })
    expect((await svc(c).checkAll()).sample).toMatchObject({ phase: 'error', code: 'redirect' })
  })

  it('reports a non-200 feed as an error, not as idle', async () => {
    const c = http({
      'https://vendor.example/feed.json': { status: 404, location: null, body: Buffer.alloc(0) }
    })
    expect((await svc(c).checkAll()).sample).toMatchObject({ phase: 'error', code: 'feed' })
  })

  it('isolates failures per pack — one dead vendor does not hide another pack update', async () => {
    state.set('beta', '1.0.0')
    state.setSource('beta', {
      origin: 'https://other.example',
      updateUrl: 'https://other.example/feed.json',
      installedAt: 1
    })
    const c = http({
      'https://vendor.example/feed.json': ok(feedBody()),
      'https://other.example/feed.json': () => {
        throw new Error('ECONNREFUSED')
      }
    })
    const res = await svc(c).checkAll()
    expect(res.sample).toEqual({ phase: 'available', version: '1.1.0' })
    expect(res.beta).toMatchObject({ phase: 'error', code: 'feed' })
  })
})

describe('apply', () => {
  const bundleRoute = { 'https://vendor.example/sample-1.1.0-win-x64.zip': ok(ZIP) }

  it('downloads, verifies, and delegates to installPack', async () => {
    const c = http({ 'https://vendor.example/feed.json': ok(feedBody()), ...bundleRoute })
    expect(await svc(c).apply('sample')).toEqual({ phase: 'ready', version: '1.1.0' })
    expect(install).toHaveBeenCalledOnce()
    const [source] = install.mock.calls[0]
    expect(typeof source).toBe('string')
  })

  it('hands installPack a real file that survives to the call', async () => {
    let seen: string | null = null
    install.mockImplementation(async (src: string) => {
      seen = fs.readFileSync(src).toString()
      return {
        ok: true,
        id: 'sample',
        version: '1.1.0',
        previousVersion: '1.0.0',
        relaunchRequired: true
      }
    })
    const c = http({ 'https://vendor.example/feed.json': ok(feedBody()), ...bundleRoute })
    await svc(c).apply('sample')
    expect(seen).toBe(ZIP.toString())
  })

  it('REFUSES a download URL on an origin other than the pin', async () => {
    // The core of the trust model: a rewritten feed must not be able to move where bytes
    // come from. Only a bundle a human (or an already-pinned update) installed may re-pin.
    const c = http({
      'https://vendor.example/feed.json': ok(
        feedBody({ url: 'https://evil.example/sample-1.1.0-win-x64.zip' })
      )
    })
    const s = await svc(c).apply('sample')
    expect(s).toMatchObject({ phase: 'error', code: 'origin-pin' })
    expect(install).not.toHaveBeenCalled()
    expect(c.urls).not.toContain('https://evil.example/sample-1.1.0-win-x64.zip')
  })

  it('refuses a non-https download URL', async () => {
    const c = http({
      'https://vendor.example/feed.json': ok(
        feedBody({ url: 'http://vendor.example/sample-1.1.0-win-x64.zip' })
      )
    })
    expect(await svc(c).apply('sample')).toMatchObject({ phase: 'error', code: 'insecure' })
    expect(install).not.toHaveBeenCalled()
  })

  it('refuses a redirected download', async () => {
    const c = http({
      'https://vendor.example/feed.json': ok(feedBody()),
      'https://vendor.example/sample-1.1.0-win-x64.zip': {
        status: 302,
        location: 'https://evil.example/x.zip',
        body: Buffer.alloc(0)
      }
    })
    expect(await svc(c).apply('sample')).toMatchObject({ phase: 'error', code: 'redirect' })
    expect(install).not.toHaveBeenCalled()
  })

  it('refuses a bundle whose sha256 does not match the feed', async () => {
    const c = http({
      'https://vendor.example/feed.json': ok(feedBody()),
      'https://vendor.example/sample-1.1.0-win-x64.zip': ok(Buffer.from('tampered'))
    })
    expect(await svc(c).apply('sample')).toMatchObject({ phase: 'error', code: 'checksum' })
    expect(install).not.toHaveBeenCalled()
  })

  it('surfaces an installPack rejection instead of claiming success', async () => {
    install.mockResolvedValue({ ok: false, code: 'checksum', error: 'bundle failed verification' })
    const c = http({ 'https://vendor.example/feed.json': ok(feedBody()), ...bundleRoute })
    expect(await svc(c).apply('sample')).toMatchObject({ phase: 'error', code: 'install' })
  })

  it('errors when the pack has no pin', async () => {
    state.setSource('sample', null)
    expect(await svc(http({})).apply('sample')).toMatchObject({ phase: 'error', code: 'feed' })
  })

  it('leaves no temp file behind on the success path', async () => {
    const c = http({ 'https://vendor.example/feed.json': ok(feedBody()), ...bundleRoute })
    await svc(c).apply('sample')
    const leftovers = fs.readdirSync(home).filter((n) => n.startsWith('.pack-update-'))
    expect(leftovers).toEqual([])
  })

  it('leaves no temp file behind on the failure path', async () => {
    const c = http({
      'https://vendor.example/feed.json': ok(feedBody()),
      'https://vendor.example/sample-1.1.0-win-x64.zip': ok(Buffer.from('tampered'))
    })
    await svc(c).apply('sample')
    const leftovers = fs.readdirSync(home).filter((n) => n.startsWith('.pack-update-'))
    expect(leftovers).toEqual([])
  })
})
