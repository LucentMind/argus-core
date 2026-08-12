import { describe, it, expect } from 'vitest'
import { makeCandidateResolver, downloadCandidate, type ResolvedCandidate } from '../depSources'
import { MAX_PACK_BUNDLE_BYTES, type HttpClient, type HttpResponse } from '../packUpdates'
import { GhError, type GhClient } from '../ghClient'

const HOST = { platform: 'win32', arch: 'x64' }
const FEED = 'https://vendor.example/common.json'
const SHA = 'a'.repeat(64)

function feedHttp(body: unknown): HttpClient {
  const respond = (): HttpResponse => ({
    status: 200,
    location: null,
    body: Buffer.from(JSON.stringify(body))
  })
  return {
    get: async () => respond(),
    getToFile: async () => {
      throw new Error('not used')
    }
  }
}

function entry(version: string, over: Record<string, unknown> = {}): object {
  return {
    version,
    argusApi: '^1',
    platform: 'win-x64',
    url: `https://vendor.example/common-${version}-win-x64.zip`,
    sha256: 'a'.repeat(64),
    ...over
  }
}

const noGh = {} as GhClient

describe('feed source', () => {
  const source = { kind: 'feed', updateUrl: FEED, origin: 'https://vendor.example' } as const

  it('picks the newest version satisfying the range', async () => {
    const http = feedHttp({
      id: 'common',
      versions: [entry('1.0.0'), entry('1.4.0'), entry('2.0.0')]
    })
    const r = await makeCandidateResolver({ http, gh: noGh, host: HOST }).resolve(
      'common',
      '^1.0.0',
      source
    )
    expect(r?.version).toBe('1.4.0')
    expect(r?.originLabel).toBe('vendor.example')
  })

  it('returns null when no version satisfies the range', async () => {
    const http = feedHttp({ id: 'common', versions: [entry('0.9.0')] })
    expect(
      await makeCandidateResolver({ http, gh: noGh, host: HOST }).resolve(
        'common',
        '^1.0.0',
        source
      )
    ).toBeNull()
  })

  it('skips an entry built for another platform', async () => {
    const http = feedHttp({
      id: 'common',
      versions: [entry('1.4.0', { platform: 'mac-arm64' }), entry('1.1.0')]
    })
    const r = await makeCandidateResolver({ http, gh: noGh, host: HOST }).resolve(
      'common',
      '^1.0.0',
      source
    )
    expect(r?.version).toBe('1.1.0')
  })

  it('skips an entry requiring an incompatible pack API', async () => {
    const http = feedHttp({
      id: 'common',
      versions: [entry('1.4.0', { argusApi: '^9' }), entry('1.1.0')]
    })
    const r = await makeCandidateResolver({ http, gh: noGh, host: HOST }).resolve(
      'common',
      '^1.0.0',
      source
    )
    expect(r?.version).toBe('1.1.0')
  })

  it('skips an entry served from a different origin than the declared feed', async () => {
    const http = feedHttp({
      id: 'common',
      versions: [
        entry('1.4.0', { url: 'https://elsewhere.example/common-1.4.0-win-x64.zip' }),
        entry('1.1.0')
      ]
    })
    const r = await makeCandidateResolver({ http, gh: noGh, host: HOST }).resolve(
      'common',
      '^1.0.0',
      source
    )
    expect(r?.version).toBe('1.1.0')
  })

  it('refuses a feed whose id does not match the dependency', async () => {
    const http = feedHttp({ id: 'somethingelse', versions: [entry('1.1.0')] })
    await expect(
      makeCandidateResolver({ http, gh: noGh, host: HOST }).resolve('common', '^1.0.0', source)
    ).rejects.toThrow(/common/)
  })
})

const noHttp = {} as HttpClient

/** Records every API path so a test can assert what was (not) fetched. */
function fakeGh(routes: Record<string, unknown>): GhClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    api: async (_ref, path) => {
      calls.push(path)
      const key = Object.keys(routes).find((k) => path.startsWith(k))
      if (!key) throw new GhError('notfound', `no route for ${path}`)
      return routes[key]
    },
    downloadAsset: async () => {
      throw new Error('not used here')
    }
  }
}

function release(tag: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const version = tag.replace(/^v/, '')
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/org/packs/releases/tag/${tag}`,
    assets: [
      {
        name: `common-${version}-win-x64.zip`,
        size: 1000,
        digest: `sha256:${SHA}`,
        browser_download_url: `https://github.com/org/packs/releases/download/${tag}/common-${version}-win-x64.zip`
      }
    ],
    ...over
  }
}

const manifestContents = (body: Record<string, unknown>): Record<string, unknown> => ({
  content: Buffer.from(JSON.stringify(body)).toString('base64'),
  encoding: 'base64'
})

/** Manifest content keyed to whichever tag the request's `ref=` query names. */
function manifestByTag(byTag: Record<string, { argusApi: string }>): (path: string) => unknown {
  return (path: string) => {
    const tag = Object.keys(byTag).find((t) => path.includes(encodeURIComponent(t)))
    if (!tag) throw new GhError('notfound', `no manifest route for ${path}`)
    return manifestContents({ id: 'common', version: tag.replace(/^v/, ''), ...byTag[tag] })
  }
}

describe('github source', () => {
  const source = { kind: 'github', host: 'github.com', owner: 'org', repo: 'packs' } as const

  it('picks the newest version satisfying the range', async () => {
    const gh = fakeGh({
      'repos/org/packs/releases': [release('v2.0.0'), release('v1.4.0'), release('v1.0.0')],
      'repos/org/packs/git/trees': { tree: [{ path: 'argus-pack.json', type: 'blob' }] }
    })
    const resolveManifest = manifestByTag({
      'v1.4.0': { argusApi: '^1' },
      'v1.0.0': { argusApi: '^1' }
    })
    const original = gh.api
    gh.api = async (ref, path) =>
      path.includes('contents') ? resolveManifest(path) : original(ref, path)

    const r = await makeCandidateResolver({ http: noHttp, gh, host: HOST }).resolve(
      'common',
      '^1.0.0',
      source
    )
    expect(r?.version).toBe('1.4.0')
    expect(r?.originLabel).toBe('github.com/org/packs')
    // v2.0.0 doesn't satisfy the range and must never be hydrated.
    expect(gh.calls.some((c) => c.includes('v2.0.0'))).toBe(false)
  })

  it('rejects a candidate declaring an incompatible pack API', async () => {
    const gh = fakeGh({
      'repos/org/packs/releases': [release('v1.4.0'), release('v1.1.0')],
      'repos/org/packs/git/trees': { tree: [{ path: 'argus-pack.json', type: 'blob' }] }
    })
    const resolveManifest = manifestByTag({
      'v1.4.0': { argusApi: '^99' },
      'v1.1.0': { argusApi: '^1' }
    })
    const original = gh.api
    gh.api = async (ref, path) =>
      path.includes('contents') ? resolveManifest(path) : original(ref, path)

    const r = await makeCandidateResolver({ http: noHttp, gh, host: HOST }).resolve(
      'common',
      '^1.0.0',
      source
    )
    expect(r?.version).toBe('1.1.0')
  })

  it('returns null when nothing satisfies the range', async () => {
    const gh = fakeGh({ 'repos/org/packs/releases': [release('v0.9.0')] })
    const r = await makeCandidateResolver({ http: noHttp, gh, host: HOST }).resolve(
      'common',
      '^1.0.0',
      source
    )
    expect(r).toBeNull()
  })

  it('skips a candidate built for another platform', async () => {
    const gh = fakeGh({
      'repos/org/packs/releases': [
        release('v1.4.0', {
          assets: [
            {
              name: 'common-1.4.0-mac-arm64.zip',
              size: 1000,
              digest: `sha256:${SHA}`,
              browser_download_url: 'https://github.com/org/packs/releases/download/v1.4.0/x.zip'
            }
          ]
        }),
        release('v1.1.0')
      ],
      'repos/org/packs/git/trees': { tree: [{ path: 'argus-pack.json', type: 'blob' }] }
    })
    const resolveManifest = manifestByTag({ 'v1.1.0': { argusApi: '^1' } })
    const original = gh.api
    gh.api = async (ref, path) =>
      path.includes('contents') ? resolveManifest(path) : original(ref, path)

    const r = await makeCandidateResolver({ http: noHttp, gh, host: HOST }).resolve(
      'common',
      '^1.0.0',
      source
    )
    expect(r?.version).toBe('1.1.0')
  })
})

describe('downloadCandidate', () => {
  const noGhClient = {
    api: async () => {
      throw new Error('not used')
    },
    downloadAsset: async () => {
      throw new Error('not used')
    }
  } as GhClient

  it('throws on a sha256 mismatch for a url download', async () => {
    const candidate: ResolvedCandidate = {
      id: 'common',
      version: '1.1.0',
      download: { kind: 'url', url: 'https://vendor.example/common.zip', sha256: SHA },
      source: { kind: 'feed', updateUrl: FEED, origin: 'https://vendor.example' },
      originLabel: 'vendor.example'
    }
    const http: HttpClient = {
      get: async () => {
        throw new Error('not used')
      },
      getToFile: async () => ({
        status: 200,
        location: null,
        sha256: 'b'.repeat(64),
        bytesWritten: 10
      })
    }
    await expect(downloadCandidate(candidate, '/tmp/out.zip', noGhClient, http)).rejects.toThrow(
      /sha256 mismatch/
    )
  })

  it('throws on a sha256 mismatch for a gh-asset download', async () => {
    const candidate: ResolvedCandidate = {
      id: 'common',
      version: '1.1.0',
      download: {
        kind: 'gh-asset',
        ref: { host: 'github.com', owner: 'org', repo: 'packs' },
        tag: 'v1.1.0',
        assetName: 'common-1.1.0-win-x64.zip',
        size: 1000,
        sha256: SHA
      },
      source: { kind: 'github', host: 'github.com', owner: 'org', repo: 'packs' },
      originLabel: 'github.com/org/packs'
    }
    const gh: GhClient = {
      api: async () => {
        throw new Error('not used')
      },
      downloadAsset: async () => ({ sha256: 'b'.repeat(64), bytesWritten: 10 })
    }
    await expect(downloadCandidate(candidate, '/tmp/out.zip', gh, noHttp)).rejects.toThrow(
      /sha256 mismatch/
    )
  })

  it('refuses an asset over the byte limit before downloading', async () => {
    const candidate: ResolvedCandidate = {
      id: 'common',
      version: '1.1.0',
      download: {
        kind: 'gh-asset',
        ref: { host: 'github.com', owner: 'org', repo: 'packs' },
        tag: 'v1.1.0',
        assetName: 'common-1.1.0-win-x64.zip',
        size: MAX_PACK_BUNDLE_BYTES + 1,
        sha256: SHA
      },
      source: { kind: 'github', host: 'github.com', owner: 'org', repo: 'packs' },
      originLabel: 'github.com/org/packs'
    }
    let downloaded = false
    const gh: GhClient = {
      api: async () => {
        throw new Error('not used')
      },
      downloadAsset: async () => {
        downloaded = true
        return { sha256: SHA, bytesWritten: MAX_PACK_BUNDLE_BYTES + 1 }
      }
    }
    await expect(downloadCandidate(candidate, '/tmp/out.zip', gh, noHttp)).rejects.toThrow(
      /byte limit/
    )
    expect(downloaded).toBe(false)
  })
})
