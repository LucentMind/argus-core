import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AtlassianClient,
  AtlassianError,
  atlassianRestConfigured,
  rovoInstanceId,
  jiraBrowseUrl,
  resolveAtlassianCreds
} from '../atlassian'
import type { ConnectorMap } from '../../../shared/connectors'
import type { OAuthLike, AtlassianAuth } from '../atlassian'

// The connector's OAuth is not authorized, so resolveAtlassianCreds never
// attaches an oauth block here.
const notAuthorized: OAuthLike = {
  status: () => 'not-authorized',
  accessToken: () => null,
  refresh: async () => false
}

const ISSUE = {
  key: 'NAV-7',
  fields: {
    summary: 'Route flickers',
    description: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'desc here' }] }]
    },
    status: { name: 'In Progress' },
    labels: ['nav'],
    reporter: { displayName: 'Ada' },
    created: '2026-07-01T00:00:00.000+0000',
    updated: '2026-07-09T00:00:00.000+0000',
    attachment: [
      {
        id: '10001',
        filename: 'trace.binlog',
        size: 123,
        mimeType: 'application/octet-stream',
        created: '2026-07-02T00:00:00.000+0000'
      }
    ]
  }
}

let server: http.Server
let mediaServer: http.Server
let base: string
let mediaBase: string
let lastAuthHeader: string | undefined
let mediaAuthHeader: string | null | undefined

// cloudId this server's accessible-resources route advertises for the OAuth
// gateway fixture below.
const CLOUD_ID = 'cloud-x'

beforeAll(async () => {
  mediaServer = http.createServer((req, res) => {
    mediaAuthHeader = req.headers.authorization ?? null
    if (req.url?.startsWith('/blob/stall')) {
      // headers arrive (fetch resolves), one partial chunk is written, then the
      // response hangs forever — exercises the idle timeout + partial-file cleanup.
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.write(Buffer.from('PARTIAL'))
      return // intentionally never res.end()
    }
    if (req.url?.startsWith('/blob/big')) {
      // two separate chunks so the per-chunk idle bump is exercised
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.write(Buffer.from('CHUNK-ONE;'))
      res.end(Buffer.from('CHUNK-TWO'))
      return
    }
    if (req.url?.startsWith('/blob/slow')) {
      // three chunks with real gaps between them: each individual gap is under
      // the idle window, but the summed gaps exceed it — proves bump() re-arms
      // per chunk rather than the abort being a fixed total deadline.
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.write(Buffer.from('SLOW-ONE;'))
      setTimeout(() => {
        res.write(Buffer.from('SLOW-TWO;'))
        setTimeout(() => res.end(Buffer.from('SLOW-THREE')), 120)
      }, 120)
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(Buffer.from('BINLOG-BYTES'))
  })
  await new Promise<void>((r) => mediaServer.listen(0, '127.0.0.1', r))
  mediaBase = `http://127.0.0.1:${(mediaServer.address() as { port: number }).port}`

  server = http.createServer((req, res) => {
    lastAuthHeader = req.headers.authorization
    // request() builds `/ex/jira/{cloudId}{pathAndQuery}` — match by substring
    // rather than prefix since the gateway prefix precedes the REST path.
    if (req.url?.startsWith('/oauth/token/accessible-resources')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ id: CLOUD_ID, url: base, scopes: ['read:jira-work'] }]))
    } else if (req.url?.includes('/rest/api/3/issue/NAV-7')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ISSUE))
    } else if (req.url?.includes('/rest/api/3/issue/GONE-1')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    } else if (req.url?.includes('/rest/api/3/issue/SECRET-1')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{}')
    } else if (req.url?.includes('/rest/api/3/attachment/content/10008')) {
      res.writeHead(303, { location: `${mediaBase}/blob/big` })
      res.end()
    } else if (req.url?.includes('/rest/api/3/attachment/content/10009')) {
      res.writeHead(303, { location: `${mediaBase}/blob/stall` })
      res.end()
    } else if (req.url?.includes('/rest/api/3/attachment/content/10007')) {
      res.writeHead(303, { location: `${mediaBase}/blob/slow` })
      res.end()
    } else if (req.url?.includes('/rest/api/3/attachment/content/10001')) {
      // Jira answers the content endpoint with a redirect to the media host
      res.writeHead(303, { location: `${mediaBase}/blob/10001` })
      res.end()
    } else if (req.url?.includes('/rest/api/3/project/search')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ values: [] }))
    } else {
      res.writeHead(500)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise((r) => server.close(r))
  await new Promise((r) => mediaServer.close(r))
})

// OAuth-only client: request() no longer has a legacy siteUrl/token path, so
// every AtlassianClient test now authorizes via oauth and reaches the test
// server through the /ex/jira/{cloudId} gateway prefix (rewritten from the
// fixed https://api.atlassian.com GATEWAY constant to `base`).
const oauthFixture = (): AtlassianAuth => ({
  instanceId: 'rovo',
  oauth: {
    serverUrl: 'https://mcp',
    accessToken: () => 'oauth-tok',
    refresh: async () => undefined
  }
})
const gatewayFetch = (): typeof fetch =>
  ((url: string, init: RequestInit) =>
    fetch(url.replace('https://api.atlassian.com', base), init)) as unknown as typeof fetch

const client = (): AtlassianClient => new AtlassianClient(oauthFixture, gatewayFetch())

describe('resolveAtlassianCreds', () => {
  const reg = (cfg: Record<string, unknown>): ConnectorMap =>
    ({ rovo: { kind: 'http', preset: 'rovo', enabled: true, config: cfg } }) as never

  it('throws not-configured when no rovo connector exists', () => {
    expect(() => resolveAtlassianCreds({} as never, notAuthorized)).toThrowError(
      expect.objectContaining({ code: 'not-configured' })
    )
  })

  it('returns an oauth block iff the connector is OAuth-authorized', () => {
    const authorized: OAuthLike = {
      status: () => 'authorized',
      accessToken: () => 'tok',
      refresh: async () => true
    }
    const cfg = reg({ url: 'https://mcp.atlassian.com/x' })
    expect(resolveAtlassianCreds(cfg, notAuthorized).oauth).toBeUndefined()
    expect(resolveAtlassianCreds(cfg, authorized).oauth).toEqual({
      serverUrl: 'https://mcp.atlassian.com/x',
      accessToken: expect.any(Function),
      refresh: expect.any(Function)
    })
  })
})

describe('rovoInstanceId', () => {
  const reg = (id: string, preset: string): ConnectorMap =>
    ({ [id]: { kind: 'http', preset, enabled: true, config: {} } }) as never

  it('returns the rovo-preset connector instance id', () => {
    expect(rovoInstanceId(reg('rovo', 'rovo'))).toBe('rovo')
  })

  it('returns null with no rovo connector configured', () => {
    expect(rovoInstanceId({} as never)).toBeNull()
    expect(rovoInstanceId(reg('other', 'github'))).toBeNull()
  })
})

describe('atlassianRestConfigured', () => {
  const reg = (cfg: Record<string, unknown>): ConnectorMap =>
    ({ rovo: { kind: 'http', preset: 'rovo', enabled: true, config: cfg } }) as never

  it('is false with no rovo connector, not-authorized OAuth (siteUrl/token no longer count)', () => {
    expect(atlassianRestConfigured({} as never, notAuthorized)).toBe(false)
    expect(
      atlassianRestConfigured(reg({ url: 'https://mcp.atlassian.com/x' }), notAuthorized)
    ).toBe(false)
    expect(
      atlassianRestConfigured(reg({ siteUrl: 'https://acme.atlassian.net' }), notAuthorized)
    ).toBe(false)
    expect(
      atlassianRestConfigured(
        reg({ apiToken: { $secret: 'connector/rovo/apiToken' } }),
        notAuthorized
      )
    ).toBe(false)
  })

  it('is true for an OAuth-authorized rovo connector even with no siteUrl/token', () => {
    const authorized: OAuthLike = {
      status: () => 'authorized',
      accessToken: () => 'tok',
      refresh: async () => true
    }
    expect(atlassianRestConfigured(reg({ url: 'https://mcp.atlassian.com/x' }), authorized)).toBe(
      true
    )
  })
})

describe('AtlassianClient', () => {
  it('getIssue maps fields, converts the ADF description, sends Bearer auth via the gateway', async () => {
    const { preview, descriptionMarkdown, raw } = await client().getIssue('NAV-7')
    expect(lastAuthHeader).toBe('Bearer oauth-tok')
    expect(preview).toMatchObject({
      key: 'NAV-7',
      summary: 'Route flickers',
      status: 'In Progress',
      labels: ['nav'],
      reporter: 'Ada'
    })
    expect(preview.attachments).toEqual([
      {
        id: '10001',
        filename: 'trace.binlog',
        size: 123,
        mimeType: 'application/octet-stream',
        createdAt: '2026-07-02T00:00:00.000+0000'
      }
    ])
    expect(descriptionMarkdown).toBe('desc here')
    expect((raw as { key: string }).key).toBe('NAV-7')
  })

  it('downloadAttachment follows the redirect and writes the bytes; auth is not forwarded cross-origin', async () => {
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-att-')), 'trace.binlog')
    await client().downloadAttachment('10001', dest)
    expect(fs.readFileSync(dest, 'utf8')).toBe('BINLOG-BYTES')
    expect(mediaAuthHeader).toBeNull() // undici strips Authorization on cross-origin redirect
  })

  it('streams a multi-chunk body to disk', async () => {
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-att-')), 'big.bin')
    await client().downloadAttachment('10008', dest)
    expect(fs.readFileSync(dest, 'utf8')).toBe('CHUNK-ONE;CHUNK-TWO')
  })

  it(
    're-arms the idle timer between chunks (slow but progressing download succeeds)',
    { timeout: 2000 },
    async () => {
      const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-att-')), 'slow.bin')
      // downloadIdleMs = 200ms: each ~120ms gap is under 200ms and re-arms, but the
      // summed gaps (~240ms) exceed it, so this passes only if the timer re-arms per
      // chunk rather than being a fixed total deadline.
      const c = new AtlassianClient(oauthFixture, gatewayFetch(), 15000, 200)
      await c.downloadAttachment('10007', dest)
      expect(fs.readFileSync(dest, 'utf8')).toBe('SLOW-ONE;SLOW-TWO;SLOW-THREE')
    }
  )

  it('aborts on an idle stall and leaves no partial file', { timeout: 2000 }, async () => {
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-att-')), 'stalled.bin')
    // 4th arg = downloadIdleMs: abort after 50ms of no progress
    const c = new AtlassianClient(oauthFixture, gatewayFetch(), 15000, 50)
    await expect(c.downloadAttachment('10009', dest)).rejects.toMatchObject({ code: 'network' })
    expect(fs.existsSync(dest)).toBe(false)
  })

  it('maps 401 → auth (with instanceId) and 404 → not-found', async () => {
    await expect(client().getIssue('SECRET-1')).rejects.toMatchObject({
      code: 'auth',
      instanceId: 'rovo'
    })
    await expect(client().getIssue('GONE-1')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('maps connection failure → network', async () => {
    // Discovery succeeds (an inline stub, not the real accessible-resources
    // route) but the actual gateway fetch targets an unreachable port.
    const deadFetch = (async (url: string, init: RequestInit) => {
      if (String(url).includes('accessible-resources'))
        return new Response(
          JSON.stringify([{ id: 'dead-cloud', url: 'https://x', scopes: ['read:jira-work'] }]),
          { status: 200 }
        )
      return fetch('http://127.0.0.1:9' + new URL(String(url)).pathname, init)
    }) as unknown as typeof fetch
    const dead = new AtlassianClient(oauthFixture, deadFetch, 2000)
    await expect(dead.getIssue('NAV-7')).rejects.toMatchObject({ code: 'network' })
  })

  it('AtlassianError is an Error with code', () => {
    const e = new AtlassianError('http', 'boom', 'rovo')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('http')
    expect(e.instanceId).toBe('rovo')
  })
})

describe('AtlassianClient siteUrl accessors', () => {
  it('cachedSiteUrl is null before any request warms the cache', () => {
    expect(client().cachedSiteUrl('rovo')).toBeNull()
  })

  it('resolveSiteUrl discovers and caches; cachedSiteUrl then reads it back sync', async () => {
    const c = client()
    expect(await c.resolveSiteUrl('rovo')).toBe(base)
    expect(c.cachedSiteUrl('rovo')).toBe(base)
  })

  it('resolveSiteUrl returns the cached siteUrl once a request has warmed it', async () => {
    const c = client()
    await c.getIssue('NAV-7') // warms cloudId+siteUrl cache for 'rovo'
    expect(await c.resolveSiteUrl('rovo')).toBe(base)
  })

  it('resolveSiteUrl returns null when unauthenticated (no oauth block at all)', async () => {
    const noOauth = (): AtlassianAuth => ({ instanceId: 'rovo' })
    const c = new AtlassianClient(noOauth, gatewayFetch())
    expect(await c.resolveSiteUrl('rovo')).toBeNull()
  })

  it('resolveSiteUrl never throws, even when creds() itself throws (e.g. resolveAtlassianCreds not-configured)', async () => {
    const throwingCreds = (): AtlassianAuth => {
      throw new AtlassianError('not-configured', 'No Atlassian connector configured')
    }
    const c = new AtlassianClient(throwingCreds, gatewayFetch())
    await expect(c.resolveSiteUrl('rovo')).resolves.toBeNull()
  })
})

describe('getComments', () => {
  const adf = (text: string): Record<string, unknown> => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })
  const comment = (id: string, text: string): Record<string, unknown> => ({
    id,
    author: { displayName: 'Ada' },
    created: '2026-07-01T00:00:00Z',
    updated: '2026-07-02T00:00:00Z',
    body: adf(text)
  })
  const ARES_JIRA = (): Response =>
    new Response(
      JSON.stringify([{ id: 'c1', url: 'https://x.atlassian.net', scopes: ['read:jira-work'] }]),
      { status: 200 }
    )

  it('pages through all comments and converts ADF bodies', async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string) => {
      calls.push(String(url))
      if (String(url).includes('accessible-resources')) return ARES_JIRA()
      const startAt = Number(new URL(String(url)).searchParams.get('startAt'))
      const body =
        startAt === 0
          ? { comments: [comment('1', 'first'), comment('2', 'second')], total: 3 }
          : { comments: [comment('3', 'third')], total: 3 }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    const client = new AtlassianClient(oauthFixture, fakeFetch)
    const out = await client.getComments('NAV-7')
    expect(calls.filter((c) => c.includes('/comment'))).toHaveLength(2)
    expect(out.map((c) => c.id)).toEqual(['1', '2', '3'])
    expect(out[0]).toMatchObject({
      author: 'Ada',
      created: '2026-07-01T00:00:00Z',
      updated: '2026-07-02T00:00:00Z',
      bodyMarkdown: 'first'
    })
  })

  it('returns [] for a ticket with no comments', async () => {
    const fakeFetch = (async (url: string) => {
      if (String(url).includes('accessible-resources')) return ARES_JIRA()
      return new Response(JSON.stringify({ comments: [], total: 0 }), { status: 200 })
    }) as unknown as typeof fetch
    const client = new AtlassianClient(oauthFixture, fakeFetch)
    expect(await client.getComments('NAV-7')).toEqual([])
  })
})

describe('jiraBrowseUrl', () => {
  it('joins site url and issue key', () => {
    expect(jiraBrowseUrl('https://acme.atlassian.net', 'NAV-7')).toBe(
      'https://acme.atlassian.net/browse/NAV-7'
    )
  })

  it('encodes the key so it cannot break out of the path', () => {
    expect(jiraBrowseUrl('https://acme.atlassian.net', 'NAV 7/../x')).toBe(
      'https://acme.atlassian.net/browse/NAV%207%2F..%2Fx'
    )
  })
})
