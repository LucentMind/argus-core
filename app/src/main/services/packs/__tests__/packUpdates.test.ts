import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { Writable } from 'node:stream'
import { createServer, type Server, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Zip } from 'zip-lib'
import {
  PackUpdatesService,
  nodeHttpClient,
  HttpTooLargeError,
  MAX_PACK_BUNDLE_BYTES,
  type HttpClient,
  type HttpResponse
} from '../packUpdates'
import { PacksStateStore, type GithubPackSource } from '../packsState'
import { GhError, type GhClient } from '../ghClient'
import { describeHost } from '../compat'
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
    platformCompatible: true,
    dependencies: []
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
    // (Important 2: this case is no longer 'idle' — see the `describe('origin-pin diagnostic')`
    // block below. `apply()` never fetches the off-origin bundle either way.)
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

  describe('origin-pin diagnostic (Important 2)', () => {
    // Before this fix, when EVERY candidate was off-origin, `selectUpdate` returned `null` just
    // like "genuinely nothing newer" — `checkAll` reported idle and the Packs page told the user
    // "No update available" while a refused update actually existed at another origin.

    it("reports code 'origin-pin', not idle, when every newer entry is off-origin", async () => {
      const c = http({
        'https://vendor.example/feed.json': ok(
          feedBody({ url: 'https://cdn.example/sample-1.1.0-win-x64.zip' })
        )
      })
      const s = (await svc(c).checkAll()).sample
      expect(s).toMatchObject({ phase: 'error', code: 'origin-pin' })
    })

    it('still selects an on-origin OLDER entry when a newer one is off-origin', async () => {
      const body = Buffer.from(
        JSON.stringify({
          id: 'sample',
          versions: [
            {
              version: '2.0.0',
              argusApi: '^1',
              platform: 'win-x64',
              url: 'https://cdn.example/sample-2.0.0-win-x64.zip',
              sha256: 'a'.repeat(64)
            },
            {
              version: '1.1.0',
              argusApi: '^1',
              platform: 'win-x64',
              url: 'https://vendor.example/sample-1.1.0-win-x64.zip',
              sha256: ZIP_SHA
            }
          ]
        })
      )
      const c = http({ 'https://vendor.example/feed.json': ok(body) })
      const s = (await svc(c).checkAll()).sample
      expect(s).toEqual({ phase: 'available', version: '1.1.0' })
    })

    it('still reports idle when there is genuinely nothing newer at all (not origin-pin)', async () => {
      const c = http({ 'https://vendor.example/feed.json': ok(feedBody({ version: '1.0.0' })) })
      expect((await svc(c).checkAll()).sample).toEqual({ phase: 'idle' })
    })
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

  it('refuses (does not fall back) when the pin is removed entirely between selection and the check', async () => {
    // Same race window as the test above, but the pin vanishes rather than moves — e.g. a
    // racing uninstall. Before the fix, `apply()` fell back to the stale `download.pin` and
    // compared the download URL against the very pin it was derived from, a check that cannot
    // fail. `pinOf` must throw instead, exactly as it did before `findUpdate` existed.
    const c = http({
      'https://vendor.example/feed.json': () => {
        state.setSource('sample', null)
        return ok(feedBody())
      },
      ...bundleRoute
    })
    const s = await svc(c).apply('sample')
    expect(s).toMatchObject({ phase: 'error', code: 'feed' })
    expect(install).not.toHaveBeenCalled()
    expect(c.urls).not.toContain('https://vendor.example/sample-1.1.0-win-x64.zip')
  })

  it('refuses (does not fall back) when the pin flips to a GitHub pin between selection and the check', async () => {
    // Same race window again, but the pin changes KIND rather than moving or vanishing. Before
    // the fix, a github pin failed the `!isGithubSource` guard and fell back to the stale feed
    // pin, silently skipping the refusal the original code made here.
    const c = http({
      'https://vendor.example/feed.json': () => {
        state.setSource('sample', {
          kind: 'github',
          host: 'github.com',
          owner: 'vendor',
          repo: 'sample',
          installedAt: 2
        })
        return ok(feedBody())
      },
      ...bundleRoute
    })
    const s = await svc(c).apply('sample')
    expect(s).toMatchObject({ phase: 'error', code: 'origin-pin' })
    expect(install).not.toHaveBeenCalled()
    expect(c.urls).not.toContain('https://vendor.example/sample-1.1.0-win-x64.zip')
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
    // Minor e: the swallowed failure must not vanish silently — it goes to console.error so it's
    // at least visible in logs, and that path was previously untested.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const c = http({ 'https://vendor.example/feed.json': ok(feedBody()), ...bundleRoute })
      await expect(svc(c).apply('sample')).resolves.toEqual({ phase: 'ready', version: '1.1.0' })
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to remove temp dir'),
        expect.any(Error)
      )
    } finally {
      rmSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it("rejects a feed body that parses as JSON but fails the feed schema, as 'invalid feed' (Minor e)", async () => {
    // Distinct from the existing 'rejects a feed whose id does not match' case (which parses
    // fine and fails a later, separate check) — this is the ZodError branch of findUpdate's own
    // `packFeedSchema.parse`, which had no covering assertion anywhere in this file.
    const body = Buffer.from(JSON.stringify({ id: 'sample', versions: [{ version: 42 }] }))
    const c = http({ 'https://vendor.example/feed.json': ok(body) })
    const s = await svc(c).apply('sample')
    expect(s).toMatchObject({ phase: 'error', code: 'feed' })
    expect((s as { message: string }).message).toMatch(/^invalid feed:/)
  })
})

describe('github-pinned packs', () => {
  const GH_PIN = {
    kind: 'github' as const,
    host: 'github.com',
    owner: 'LucentMind',
    repo: 'demo_pack',
    installedAt: 0
  }

  function ghRoutes(sha: string): Record<string, unknown> {
    return {
      'repos/LucentMind/demo_pack/releases': [
        {
          tag_name: 'v1.1.0',
          draft: false,
          prerelease: false,
          html_url: 'https://github.com/LucentMind/demo_pack/releases/tag/v1.1.0',
          assets: [
            {
              name: 'sample-1.1.0-win-x64.zip',
              size: 21,
              digest: `sha256:${sha}`,
              browser_download_url:
                'https://github.com/LucentMind/demo_pack/releases/download/v1.1.0/sample-1.1.0-win-x64.zip'
            }
          ]
        }
      ],
      'repos/LucentMind/demo_pack/git/trees': {
        tree: [{ path: 'packs/sample/argus-pack.json', type: 'blob' }]
      },
      'repos/LucentMind/demo_pack/contents': {
        content: Buffer.from(
          JSON.stringify({ id: 'sample', version: '1.1.0', argusApi: '^1' })
        ).toString('base64')
      }
    }
  }

  function ghClient(routes: Record<string, unknown>, onDownload?: () => void): GhClient {
    return {
      api: async (_ref, p) => {
        const key = Object.keys(routes).find((k) => p.startsWith(k))
        if (!key) throw new GhError('notfound', p)
        return routes[key]
      },
      downloadAsset: async (_ref, _tag, _name, dest) => {
        fs.writeFileSync(dest, ZIP)
        onDownload?.()
        return { sha256: ZIP_SHA, bytesWritten: ZIP.length }
      }
    }
  }

  /** The HTTP client must never be reached for a github pin — any call here is the branch
   *  leaking, so this records rather than silently succeeding. */
  function neverHttp(): HttpClient & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      get: async (url) => {
        calls.push(url)
        throw new Error(`unexpected feed fetch: ${url}`)
      },
      getToFile: async (url) => {
        calls.push(url)
        throw new Error(`unexpected download: ${url}`)
      }
    }
  }

  /** Mirrors the file's `svc()`, but injects a gh client and a never-called HTTP client. */
  function ghSvc(gh: GhClient, http: HttpClient = neverHttp()): PackUpdatesService {
    return new PackUpdatesService({
      argusHome: home,
      state,
      http,
      gh,
      install: install as never,
      inspectBundleSource: inspect as never,
      host: WIN,
      now: () => 1000
    })
  }

  beforeEach(() => {
    state.setSource('sample', GH_PIN)
  })

  it('reports an available update from a release', async () => {
    expect(await ghSvc(ghClient(ghRoutes(ZIP_SHA))).checkAll()).toEqual({
      sample: { phase: 'available', version: '1.1.0' }
    })
  })

  it('downloads through gh, verifies the digest, and installs', async () => {
    expect(await ghSvc(ghClient(ghRoutes(ZIP_SHA))).apply('sample')).toEqual({
      phase: 'ready',
      version: '1.1.0'
    })
    expect(install).toHaveBeenCalledOnce()
  })

  it('refuses a bundle whose digest does not match', async () => {
    const status = await ghSvc(ghClient(ghRoutes('b'.repeat(64)))).apply('sample')
    expect(status).toMatchObject({ phase: 'error', code: 'checksum' })
    expect(install).not.toHaveBeenCalled()
  })

  it('reports a renamed repo as origin-pin, reusing the manual-download branch', async () => {
    const routes = ghRoutes(ZIP_SHA)
    ;(routes['repos/LucentMind/demo_pack/releases'] as Array<Record<string, unknown>>)[0].html_url =
      'https://github.com/OtherOrg/demo_pack/releases/tag/v1.1.0'
    expect(await ghSvc(ghClient(routes)).checkAll()).toMatchObject({
      sample: { phase: 'error', code: 'origin-pin' }
    })
  })

  it('reports a gh failure with the gh code, not the feed code', async () => {
    const failing: GhClient = {
      api: async () => {
        throw new GhError('auth', 'the GitHub CLI is not authenticated')
      },
      downloadAsset: async () => {
        throw new Error('unused')
      }
    }
    expect(await ghSvc(failing).checkAll()).toMatchObject({
      sample: { phase: 'error', code: 'gh' }
    })
  })

  it('refuses an asset larger than the bundle cap before downloading it', async () => {
    const routes = ghRoutes(ZIP_SHA)
    ;(
      (routes['repos/LucentMind/demo_pack/releases'] as Array<Record<string, unknown>>)[0]
        .assets as Array<Record<string, unknown>>
    )[0].size = MAX_PACK_BUNDLE_BYTES + 1
    const downloaded = vi.fn()
    expect(await ghSvc(ghClient(routes, downloaded)).apply('sample')).toMatchObject({
      phase: 'error',
      code: 'too-large'
    })
    expect(downloaded).not.toHaveBeenCalled()
  })

  it('never touches the HTTP client for a github pin', async () => {
    const http = neverHttp()
    await ghSvc(ghClient(ghRoutes(ZIP_SHA)), http).checkAll()
    // The two paths must not bleed: an https feed fetch here would mean the branch is wrong.
    expect(http.calls).toEqual([])
  })

  it('records the resolved manifest path so the next check skips the tree search', async () => {
    const gh = ghClient(ghRoutes(ZIP_SHA))
    await ghSvc(gh).checkAll()
    expect(state.getSource('sample')).toMatchObject({
      manifestPath: 'packs/sample/argus-pack.json'
    })
  })
})

/**
 * Critical (whole-branch review): every test above injects a FAKE `install`, so the real
 * `installPack` never runs and nothing here ever asserted the pin AFTER a github-pinned update.
 * `installPack` re-derives the pin from the freshly installed bundle's OWN manifest unless told
 * otherwise — for a github-pinned pack that means an update whose manifest names a feed would
 * silently re-arm the feed path, and one that names nothing at all would DELETE the pin, leaving
 * the pack permanently unchecked with no UI signal. These tests run the REAL `installPack` (no
 * `install` override in the deps below) against a REAL bundle zip, built the way
 * `install.test.ts`'s `makeBundleDir`/`zipOf` do, so the gap between `packUpdates.ts` and
 * `install.ts` is actually closed rather than asserted only on the fake's call arguments.
 */
describe('github pin survives an update — real installPack (Critical)', () => {
  const TAG = 'v1.1.0'
  const ASSET = 'sample-1.1.0-win-x64.zip'
  const REPO = { host: 'github.com', owner: 'LucentMind', repo: 'demo_pack' }
  const GH_PIN: GithubPackSource = {
    kind: 'github',
    ...REPO,
    manifestPath: 'packs/sample/argus-pack.json',
    installedAt: 0
  }

  beforeEach(() => {
    state.setSource('sample', GH_PIN)
  })

  /** A staged bundle DIR (manifest + valid CHECKSUMS) — mirrors install.test.ts's makeBundleDir,
   *  minus the extras this test doesn't need. */
  function makeBundleDir(over: Record<string, unknown> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pu-bundle-'))
    const manifest = {
      id: 'sample',
      displayName: 'Sample',
      version: '1.1.0',
      argusApi: '^1',
      platform: describeHost(WIN),
      ...over
    }
    fs.writeFileSync(path.join(dir, 'argus-pack.json'), JSON.stringify(manifest, null, 2) + '\n')
    const sum = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(dir, 'argus-pack.json')))
      .digest('hex')
    fs.writeFileSync(path.join(dir, 'CHECKSUMS'), `${sum}  argus-pack.json\n`)
    return dir
  }

  /** Mirrors install.test.ts's zipOf, minus the multi-file walk this test doesn't need. */
  async function zipOf(dir: string): Promise<string> {
    const zip = new Zip()
    zip.addFile(path.join(dir, 'argus-pack.json'), 'argus-pack.json')
    zip.addFile(path.join(dir, 'CHECKSUMS'), 'CHECKSUMS')
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pu-zip-')), 'sample.zip')
    await zip.archive(out)
    return out
  }

  /** A `GhClient` whose `downloadAsset` writes a REAL bundle zip (built above) to `destPath`,
   *  rather than an opaque buffer — the point of this describe block is to run the real
   *  `inspectBundleSource`/`installPack` against real bytes. */
  function ghClientForBundle(zipPath: string, sha256: string): GhClient {
    return {
      api: async (_ref, p) => {
        if (p.startsWith(`repos/${REPO.owner}/${REPO.repo}/releases`)) {
          return [
            {
              tag_name: TAG,
              draft: false,
              prerelease: false,
              html_url: `https://github.com/${REPO.owner}/${REPO.repo}/releases/tag/${TAG}`,
              assets: [
                {
                  name: ASSET,
                  size: fs.statSync(zipPath).size,
                  digest: `sha256:${sha256}`,
                  browser_download_url: `https://github.com/${REPO.owner}/${REPO.repo}/releases/download/${TAG}/${ASSET}`
                }
              ]
            }
          ]
        }
        if (p.startsWith(`repos/${REPO.owner}/${REPO.repo}/git/trees`)) {
          return { tree: [{ path: 'packs/sample/argus-pack.json', type: 'blob' }] }
        }
        if (p.startsWith(`repos/${REPO.owner}/${REPO.repo}/contents`)) {
          // Only `id`/`argusApi` are read from this endpoint (readPackManifest's
          // partialManifestSchema) — the bundle's OWN manifest (read after download, from inside
          // the zip) is what actually carries updateRepo/updateUrl for this test.
          return {
            content: Buffer.from(
              JSON.stringify({ id: 'sample', version: '1.1.0', argusApi: '^1' })
            ).toString('base64')
          }
        }
        throw new GhError('notfound', p)
      },
      downloadAsset: async (_ref, _tag, _name, dest) => {
        fs.copyFileSync(zipPath, dest)
        return { sha256, bytesWritten: fs.statSync(zipPath).size }
      }
    }
  }

  function neverHttp(): HttpClient {
    return {
      get: async (url) => {
        throw new Error(`unexpected feed fetch: ${url}`)
      },
      getToFile: async (url) => {
        throw new Error(`unexpected download: ${url}`)
      }
    }
  }

  /** Builds a real bundle whose manifest carries `over`, applies the update with the REAL
   *  `installPack`/`inspectBundleSource` (neither is overridden below), and returns the
   *  resulting `UpdateStatus`. */
  async function applyRealUpdate(over: Record<string, unknown>): Promise<unknown> {
    const dir = makeBundleDir(over)
    const zipPath = await zipOf(dir)
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
    const gh = ghClientForBundle(zipPath, sha256)
    const service = new PackUpdatesService({
      argusHome: home,
      state,
      http: neverHttp(),
      gh,
      host: WIN,
      now: () => 1000
      // Deliberately no `install`/`inspectBundleSource` override — this is the whole point.
    })
    return service.apply('sample')
  }

  it('stays pinned to the same repo when the updated manifest names it via updateRepo, and keeps manifestPath', async () => {
    const status = await applyRealUpdate({ updateRepo: 'LucentMind/demo_pack' })
    expect(status).toEqual({ phase: 'ready', version: '1.1.0' })
    expect(state.getSource('sample')).toMatchObject({
      kind: 'github',
      ...REPO,
      manifestPath: 'packs/sample/argus-pack.json'
    })
  })

  it('stays pinned to github — does NOT become a feed pin — when the updated manifest declares updateUrl', async () => {
    const status = await applyRealUpdate({ updateUrl: 'https://vendor.example/feed.json' })
    expect(status).toEqual({ phase: 'ready', version: '1.1.0' })
    expect(state.getSource('sample')).toMatchObject({ kind: 'github', ...REPO })
  })

  it('stays pinned to github — is NOT deleted — when the updated manifest declares no update source at all', async () => {
    const status = await applyRealUpdate({})
    expect(status).toEqual({ phase: 'ready', version: '1.1.0' })
    expect(state.getSource('sample')).toMatchObject({ kind: 'github', ...REPO })
  })

  it('the documented escape hatch: re-pins to a DIFFERENT repo the updated manifest deliberately names', async () => {
    const status = await applyRealUpdate({ updateRepo: 'OtherOrg/other_repo' })
    expect(status).toEqual({ phase: 'ready', version: '1.1.0' })
    expect(state.getSource('sample')).toMatchObject({
      kind: 'github',
      host: 'github.com',
      owner: 'OtherOrg',
      repo: 'other_repo'
    })
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

  async function closeServer(): Promise<void> {
    if (!server) return
    const s = server
    server = null
    await new Promise<void>((resolve) => s.close(() => resolve()))
    s.closeAllConnections()
  }

  afterEach(closeServer)

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

    /**
     * Important 1 (verification review of the streaming rewrite): `getToFile` writes to
     * `fs.createWriteStream(destPath)` across several `await`s with no persistent `'error'`
     * listener attached — a write failure is emitted from an fs callback, not thrown from
     * anything awaited, so with nothing listening it becomes an UNCAUGHT EXCEPTION (a crash of
     * the Electron main process), and if it happens to be absorbed by a stale per-drain listener
     * instead, the loop's next `write()` re-enters a `new Promise(drain|error)` that — because a
     * destroyed stream never emits 'drain' or a second 'error' — never settles, hanging `apply()`
     * forever. Both are reproduced below against the real exported `nodeHttpClient`, not a fake.
     */
    describe('write-stream failure handling (Important 1)', () => {
      afterEach(() => {
        vi.restoreAllMocks()
      })

      it('Probe A: rejects (never resolves as success, never crashes) when the destination cannot be opened', async () => {
        await listen((_req, res) => {
          res.writeHead(200)
          res.end(Buffer.from('hello world'))
        })
        // A destPath under a directory that does not exist makes the underlying `open()` fail
        // with ENOENT — asynchronously, after `getToFile` has already read/hashed the body and
        // called `out.end()`. Before the fix, this raced the stream's real (but never-emitted-
        // to-anything) 'error' against `out.end(callback)`'s 'finish' callback and could resolve
        // as if the download had SUCCEEDED — worse than a crash, a silently wrong result — while
        // nothing was ever written to `badDest`. Rejecting here is the fix; the exact failure
        // mode without it depends on timing (crash in some environments, false success in this
        // one — both are exactly the "not a rejected promise" defect Important 1 describes).
        const badDest = path.join(dir, 'does-not-exist', 'bundle.zip')
        await expect(
          nodeHttpClient.getToFile(baseUrl, badDest, { maxBytes: 1024, timeoutMs: 2000 })
        ).rejects.toThrow()
        expect(fs.existsSync(badDest)).toBe(false)
      }, 5000)

      it(
        'Probe B: rejects (does not hang) when a write error is silently absorbed because no ' +
          "wait was active at the moment it fired, and the loop's NEXT write() re-enters a wait " +
          'a stream that will never emit drain or a second error again',
        async () => {
          // A REAL Writable — Node's actual "a destroyed stream's write() short-circuits to
          // `false` forever, and 'error' is emitted at most ONCE" behavior (verified directly
          // against Node before writing this test) is exactly the mechanism the bug depends on;
          // a hand-rolled fake wouldn't prove anything about the real fs.WriteStream contract.
          //
          // Chunk 1's write() call returns `true` (no backpressure — nothing is `await`ing
          // 'drain' or 'error' at that moment) while its underlying write FAILS asynchronously
          // a tick later, destroying the stream with nothing listening for it to reject. Chunk
          // 2 arrives after a real gap (long enough for that destroy to complete), so its
          // write() call — now against an already-destroyed stream — returns `false`, and the
          // OLD code's per-call `new Promise((resolve,reject)) => { once('drain'); once('error') }`
          // waits on events that will never come again: an unconditional hang.
          let calls = 0
          const flaky = new Writable({
            highWaterMark: 1024 * 1024, // large: chunk 1 alone must NOT need to wait for drain
            write(_chunk, _enc, callback) {
              calls++
              if (calls === 1) {
                queueMicrotask(() => callback(new Error('simulated ENOSPC')))
                return
              }
              queueMicrotask(() => callback())
            }
          })
          vi.spyOn(fs, 'createWriteStream').mockReturnValue(flaky as unknown as fs.WriteStream)

          await listen((_req, res) => {
            res.writeHead(200)
            ;(async () => {
              res.write(Buffer.alloc(256, 'x')) // chunk 1 — its write() fails after returning true
              await new Promise((r) => setTimeout(r, 30)) // let the async failure destroy `out`
              res.write(Buffer.alloc(256, 'y')) // chunk 2 — write() against an already-dead stream
              res.end()
            })()
          })

          await expect(
            nodeHttpClient.getToFile(baseUrl, dest, { maxBytes: 1024 * 1024, timeoutMs: 2000 })
          ).rejects.toThrow(/simulated ENOSPC/)
        },
        5000
      )

      it('does not accumulate error listeners across many drain waits, and warns of none', async () => {
        // A tiny highWaterMark forces `write()` to return `false` (and thus a drain wait) on
        // nearly every chunk, deterministically reproducing the "many drains" shape the review
        // measured (8 MiB / 65 drains) without depending on real disk speed.
        //
        // Rather than asserting one specific listener COUNT (Node's own `stream/promises`
        // `finished()` leaves a fixed residual of its own, an implementation detail that isn't
        // this fix's to pin down), this compares a few-drain run against a many-drain run: if
        // the old per-drain-leaked `.once('error', reject)` bug were still present, the second
        // count would be roughly 12x the first (60 vs 5 leaked listeners) instead of identical.
        const countAfter = async (chunks: number): Promise<number> => {
          let captured: Writable | null = null
          const realCreateWriteStream = fs.createWriteStream.bind(fs)
          const spy = vi.spyOn(fs, 'createWriteStream').mockImplementation((p, opts) => {
            const s = realCreateWriteStream(p as string, {
              ...(typeof opts === 'object' ? opts : {}),
              highWaterMark: 16
            })
            captured = s
            return s
          })
          await listen((_req, res) => {
            res.writeHead(200)
            ;(async () => {
              for (let i = 0; i < chunks; i++) {
                res.write(Buffer.alloc(512, 'y'))
                await new Promise((r) => setTimeout(r, 1))
              }
              res.end()
            })()
          })
          const res = await nodeHttpClient.getToFile(baseUrl, dest, {
            maxBytes: 10 * 1024 * 1024,
            timeoutMs: 5000
          })
          expect(res.status).toBe(200)
          spy.mockRestore()
          const count = captured!.listenerCount('error')
          await closeServer() // each call to `listen()` opens a new server; don't leak the old one
          return count
        }

        const warnings: string[] = []
        const onWarning = (w: Error): void => {
          warnings.push(`${w.name}: ${w.message}`)
        }
        process.on('warning', onWarning)
        try {
          const few = await countAfter(5)
          const many = await countAfter(60)
          expect(many).toBe(few)
          expect(warnings.filter((w) => w.includes('MaxListenersExceededWarning'))).toEqual([])
        } finally {
          process.off('warning', onWarning)
        }
      })
    })
  })
})
