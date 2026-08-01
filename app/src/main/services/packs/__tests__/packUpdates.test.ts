import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createServer, type Server, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  PackUpdatesService,
  nodeHttpClient,
  HttpTooLargeError,
  type HttpClient,
  type HttpResponse
} from '../packUpdates'
import { PacksStateStore } from '../packsState'
import type { InstallResult, InspectResult } from '../../../../shared/packs'

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

/**
 * Serves the feed and the bundle from a routing table; records every URL requested.
 * `getToFile` reads the same table as `get` — a route's `body` is written to `destPath` when
 * `status === 200`, mirroring what `nodeHttpClient.getToFile` does against a real server; a
 * non-200 route returns its status/location without touching the filesystem at all.
 */
function http(routes: Record<string, HttpResponse | (() => HttpResponse)>): HttpClient & {
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
    },
    getToFile: async (url, destPath) => {
      urls.push(url)
      const route = routes[url]
      if (!route) throw new Error(`unexpected fetch: ${url}`)
      // A throwing function route (e.g. HttpTooLargeError) propagates as-is; one that RETURNS
      // an HttpResponse is handled identically to a plain object route below, by writing its
      // body to `destPath` — same as `nodeHttpClient.getToFile` would for a real 200 response.
      const r = typeof route === 'function' ? route() : route
      if (r.status !== 200)
        return { status: r.status, location: r.location, sha256: '', bytesWritten: 0 }
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

let home: string
let state: PacksStateStore
let install: ReturnType<typeof vi.fn>
let inspect: ReturnType<typeof vi.fn>

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
  // Matches the standard fixture (pack 'sample', feed entry '1.1.0') by default — the Fix-1
  // tests override this to simulate a bundle whose declared identity disagrees with the feed.
  inspect = vi.fn(async (): Promise<InspectResult> => ({
    id: 'sample',
    version: '1.1.0',
    platform: 'win-x64',
    apiCompatible: true,
    platformCompatible: true
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
    inspectBundleSource: inspect as never,
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

  it('reports too-large, not feed, when the feed response breaches its byte cap', async () => {
    // The fake throws the exact shape the real nodeHttpClient throws (see the
    // `describe('nodeHttpClient')` block below, which proves the real client throws this too).
    const c = http({
      'https://vendor.example/feed.json': () => {
        throw new HttpTooLargeError(1024)
      }
    })
    const s = (await svc(c).checkAll()).sample
    expect(s).toMatchObject({ phase: 'error', code: 'too-large' })
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

  it('never offers an update whose only candidate is off-origin (Fix 2: filtered at selection)', async () => {
    // The core of the trust model: a rewritten feed must not be able to move where bytes come
    // from. Since `selectUpdate` now filters candidates by origin (see feed.test.ts), an
    // off-origin entry is never even selected as "the update" — the bundle URL is never touched.
    const c = http({
      'https://vendor.example/feed.json': ok(
        feedBody({ url: 'https://evil.example/sample-1.1.0-win-x64.zip' })
      )
    })
    const s = await svc(c).apply('sample')
    expect(s).toEqual({ phase: 'idle' })
    expect(install).not.toHaveBeenCalled()
    expect(c.urls).not.toContain('https://evil.example/sample-1.1.0-win-x64.zip')
  })

  it("apply's own origin check still refuses a bundle if the pin changes between selection and the check", async () => {
    // Defense in depth: `findUpdate` reads the pin once (to filter candidates) and `apply`
    // re-reads it immediately after, with a real network fetch in between. If the pin changes
    // in that window (e.g. a racing uninstall/reinstall rewrites the source), the entry
    // selected under the OLD origin must still be refused against the NEW one — this is why the
    // explicit check in `apply` stays even though selection now also filters by origin.
    const c = http({
      'https://vendor.example/feed.json': () => {
        state.setSource('sample', {
          origin: 'https://other.example',
          updateUrl: 'https://other.example/feed.json',
          installedAt: 2
        })
        return ok(feedBody())
      }
    })
    const s = await svc(c).apply('sample')
    expect(s).toMatchObject({ phase: 'error', code: 'origin-pin' })
    expect(install).not.toHaveBeenCalled()
  })

  it('refuses a non-https download URL even behind a corrupted/legacy non-https pin', async () => {
    // pin.origin is normally always https (derived from a manifest.updateUrl that must be
    // https), so origin-based selection alone would already exclude a non-https entry. But
    // nothing schema-validates a hand-edited or pre-migration state file, so a corrupted pin
    // could itself be non-https — `assertHttps` on the winning entry is the backstop for that.
    state.setSource('sample', {
      origin: 'http://vendor.example',
      updateUrl: 'https://vendor.example/feed.json',
      installedAt: 1
    })
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

  it('REFUSES a downloaded bundle whose declared id differs from the pack being updated', async () => {
    // Fix 1: every guard up to this point is scoped to the FEED (feed.id, the entry's origin,
    // its sha256) — none of them stop a zip whose argus-pack.json declares a different pack id.
    // installPack trusts that id completely (installs to packs/<that id>, re-pins its origin),
    // so this check must run BEFORE install() is ever called.
    inspect.mockResolvedValue({
      id: 'navigation',
      version: '1.1.0',
      platform: 'win-x64',
      apiCompatible: true,
      platformCompatible: true
    })
    const c = http({ 'https://vendor.example/feed.json': ok(feedBody()), ...bundleRoute })
    const s = await svc(c).apply('sample')
    expect(s).toMatchObject({ phase: 'error', code: 'install' })
    expect(install).not.toHaveBeenCalled()
  })

  it('REFUSES a downloaded bundle whose declared version differs from the feed entry', async () => {
    inspect.mockResolvedValue({
      id: 'sample',
      version: '0.9.0',
      platform: 'win-x64',
      apiCompatible: true,
      platformCompatible: true
    })
    const c = http({ 'https://vendor.example/feed.json': ok(feedBody()), ...bundleRoute })
    const s = await svc(c).apply('sample')
    expect(s).toMatchObject({ phase: 'error', code: 'install' })
    expect(install).not.toHaveBeenCalled()
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

  it('leaves no temp file behind on the install-rejection failure path', async () => {
    // Retargeted (Fix 6f): the previous version of this test used a checksum-mismatch failure,
    // which throws BEFORE `mkdtempSync` is ever reached — no dir is created either way, so it
    // passed even with the entire `finally` deleted. The install-rejection path below always
    // creates the temp dir first (the download must land somewhere), making this non-vacuous.
    install.mockResolvedValue({ ok: false, code: 'checksum', error: 'bundle failed verification' })
    const c = http({ 'https://vendor.example/feed.json': ok(feedBody()), ...bundleRoute })
    await svc(c).apply('sample')
    const leftovers = fs.readdirSync(home).filter((n) => n.startsWith('.pack-update-'))
    expect(leftovers).toEqual([])
  })

  it('reports too-large, not feed, when the bundle download breaches its byte cap', async () => {
    const c = http({
      'https://vendor.example/feed.json': ok(feedBody()),
      'https://vendor.example/sample-1.1.0-win-x64.zip': () => {
        throw new HttpTooLargeError(512 * 1024 * 1024)
      }
    })
    expect(await svc(c).apply('sample')).toMatchObject({ phase: 'error', code: 'too-large' })
    expect(install).not.toHaveBeenCalled()
  })

  it("reports 'download', not 'feed', when the bundle download fails outright (Fix 6b)", async () => {
    const c = http({
      'https://vendor.example/feed.json': ok(feedBody()),
      'https://vendor.example/sample-1.1.0-win-x64.zip': {
        status: 500,
        location: null,
        body: Buffer.alloc(0)
      }
    })
    expect(await svc(c).apply('sample')).toMatchObject({ phase: 'error', code: 'download' })
    expect(install).not.toHaveBeenCalled()
  })

  it('still resolves to the correct UpdateStatus when temp-dir cleanup fails', async () => {
    // Realistic on Windows: an AV scanner or installPack's own extract can still hold a handle
    // on the just-written zip when apply() tries to remove the temp dir. That must not turn a
    // successful apply into a rejected promise, and must not surface as anything but 'ready'.
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked')
    })
    try {
      const c = http({ 'https://vendor.example/feed.json': ok(feedBody()), ...bundleRoute })
      await expect(svc(c).apply('sample')).resolves.toEqual({ phase: 'ready', version: '1.1.0' })
    } finally {
      rmSpy.mockRestore()
    }
  })
})

/**
 * Every other test in this file injects a fake `HttpClient` whose `get` ignores `maxBytes`
 * entirely, so the production `nodeHttpClient` — the byte cap, the `redirect: 'manual'` flag,
 * the abort/timeout wiring, and the `location` header read — was previously exercised by
 * nothing. These tests drive it against a real `http.createServer` on an ephemeral port. Plain
 * `http` (not https) is correct here: the https-only policy lives in the service's
 * `assertHttps`, not in the transport.
 */
describe('nodeHttpClient', () => {
  let server: Server | null = null
  let baseUrl: string

  function listen(handler: RequestListener): Promise<void> {
    return new Promise((resolve) => {
      server = createServer(handler)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server!.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${port}`
        resolve()
      })
    })
  }

  afterEach(async () => {
    if (!server) return
    const s = server
    server = null
    await new Promise<void>((resolve) => s.close(() => resolve()))
    s.closeAllConnections()
  })

  it('surfaces a 302 status and its Location header without following it', async () => {
    await listen((_req, res) => {
      res.writeHead(302, { Location: 'https://evil.example/x' })
      res.end()
    })
    const res = await nodeHttpClient.get(baseUrl, { maxBytes: 1024, timeoutMs: 2000 })
    expect(res.status).toBe(302)
    expect(res.location).toBe('https://evil.example/x')
  })

  it('rejects with HttpTooLargeError when the body exceeds maxBytes, and a bigger cap would not', async () => {
    const body = Buffer.alloc(2048, 'a')
    await listen((_req, res) => {
      res.writeHead(200)
      res.end(body)
    })
    await expect(
      nodeHttpClient.get(baseUrl, { maxBytes: 1024, timeoutMs: 2000 })
    ).rejects.toBeInstanceOf(HttpTooLargeError)
    // Proves the cap itself is what rejected it, not something incidental about the body.
    const res = await nodeHttpClient.get(baseUrl, { maxBytes: 4096, timeoutMs: 2000 })
    expect(res.body.equals(body)).toBe(true)
  })

  it('round-trips a normal 200 body under the cap', async () => {
    await listen((_req, res) => {
      res.writeHead(200)
      res.end('hello world')
    })
    const res = await nodeHttpClient.get(baseUrl, { maxBytes: 1024, timeoutMs: 2000 })
    expect(res.status).toBe(200)
    expect(res.body.toString('utf8')).toBe('hello world')
  })

  it('rejects a hung response once the timeout elapses', async () => {
    await listen(() => {
      // Never write a header or end the response — the client must abort on its own.
    })
    await expect(nodeHttpClient.get(baseUrl, { maxBytes: 1024, timeoutMs: 50 })).rejects.toThrow()
  })

  /**
   * Fix 5: the bundle download streams straight to a file (hashing incrementally) instead of
   * buffering the whole body twice. These mirror the four `get()` cases above one-for-one
   * against the same real server, plus a check that a rejected/partial download never leaves
   * bytes on disk.
   */
  describe('getToFile', () => {
    let dir: string
    let dest: string

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pu-gtf-'))
      dest = path.join(dir, 'bundle.zip')
    })

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('surfaces a 302 status and its Location header without writing anything to disk', async () => {
      await listen((_req, res) => {
        res.writeHead(302, { Location: 'https://evil.example/x' })
        res.end()
      })
      const res = await nodeHttpClient.getToFile(baseUrl, dest, { maxBytes: 1024, timeoutMs: 2000 })
      expect(res.status).toBe(302)
      expect(res.location).toBe('https://evil.example/x')
      expect(fs.existsSync(dest)).toBe(false)
    })

    it('rejects with HttpTooLargeError when the body exceeds maxBytes, and a bigger cap would not', async () => {
      const body = Buffer.alloc(2048, 'a')
      await listen((_req, res) => {
        res.writeHead(200)
        res.end(body)
      })
      await expect(
        nodeHttpClient.getToFile(baseUrl, dest, { maxBytes: 1024, timeoutMs: 2000 })
      ).rejects.toBeInstanceOf(HttpTooLargeError)
      // Proves the cap itself is what rejected it, not something incidental about the body.
      const res = await nodeHttpClient.getToFile(baseUrl, dest, { maxBytes: 4096, timeoutMs: 2000 })
      expect(res.status).toBe(200)
      expect(fs.readFileSync(dest).equals(body)).toBe(true)
    })

    it('removes an already-partially-written file once the cap is exceeded mid-stream', async () => {
      // A single small response often arrives as ONE chunk, in which case the cap trips before
      // `out.write()` is ever called and no file is created either way — a cleanup bug wouldn't
      // show up. Splitting the body into two writes with a real gap between them forces the
      // first (under-cap) chunk to actually land on disk before the second one pushes the
      // running total over `maxBytes`, so this exercises the cleanup path for real.
      const first = Buffer.alloc(700, 'a')
      const second = Buffer.alloc(700, 'b')
      await listen((_req, res) => {
        res.writeHead(200)
        res.write(first)
        setTimeout(() => res.end(second), 20)
      })
      await expect(
        nodeHttpClient.getToFile(baseUrl, dest, { maxBytes: 1024, timeoutMs: 2000 })
      ).rejects.toBeInstanceOf(HttpTooLargeError)
      expect(fs.existsSync(dest)).toBe(false)
    })

    it('round-trips a normal 200 body under the cap, with a matching sha256 and byte count', async () => {
      const body = Buffer.from('hello world')
      await listen((_req, res) => {
        res.writeHead(200)
        res.end(body)
      })
      const res = await nodeHttpClient.getToFile(baseUrl, dest, { maxBytes: 1024, timeoutMs: 2000 })
      expect(res.status).toBe(200)
      expect(res.bytesWritten).toBe(body.length)
      expect(res.sha256).toBe(crypto.createHash('sha256').update(body).digest('hex'))
      expect(fs.readFileSync(dest).equals(body)).toBe(true)
    })

    it('rejects a hung response once the timeout elapses, leaving no file behind', async () => {
      await listen(() => {
        // Never write a header or end the response — the client must abort on its own.
      })
      await expect(
        nodeHttpClient.getToFile(baseUrl, dest, { maxBytes: 1024, timeoutMs: 50 })
      ).rejects.toThrow()
      expect(fs.existsSync(dest)).toBe(false)
    })
  })
})
