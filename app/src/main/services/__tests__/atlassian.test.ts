import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AtlassianClient,
  AtlassianError,
  atlassianRestConfigured,
  atlassianSiteUrl,
  jiraBrowseUrl,
  resolveAtlassianCreds
} from '../atlassian'
import type { ConnectorMap } from '../../../shared/connectors'
import type { OAuthLike, AtlassianAuth } from '../atlassian'

// Legacy REST-token path: the connector's OAuth is not authorized, so
// resolveAtlassianCreds never attaches an oauth block here.
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
  siteUrl: null,
  token: null,
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

  it('resolves siteUrl + PAT from the rovo-preset connector', () => {
    const c = resolveAtlassianCreds(
      reg({
        url: 'https://mcp.atlassian.com/x',
        siteUrl: 'https://acme.atlassian.net/',
        apiToken: { $secret: 'connector/rovo/apiToken' }
      }),
      (n) => (n === 'connector/rovo/apiToken' ? 'PAT123' : null),
      notAuthorized
    )
    expect(c).toEqual({
      instanceId: 'rovo',
      siteUrl: 'https://acme.atlassian.net',
      token: 'PAT123'
    })
  })
  it('resolves the optional email for Basic auth (Jira Cloud); blank email is omitted', () => {
    const withEmail = resolveAtlassianCreds(
      reg({
        siteUrl: 'https://acme.atlassian.net',
        email: 'ada@acme.test',
        apiToken: { $secret: 'connector/rovo/apiToken' }
      }),
      () => 'PAT123',
      notAuthorized
    )
    expect(withEmail.email).toBe('ada@acme.test')
    const blank = resolveAtlassianCreds(
      reg({
        siteUrl: 'https://acme.atlassian.net',
        email: '   ',
        apiToken: { $secret: 'connector/rovo/apiToken' }
      }),
      () => 'PAT123',
      notAuthorized
    )
    expect(blank.email).toBeUndefined()
  })

  it('throws not-configured when no rovo connector exists; missing site/token no longer throw', () => {
    expect(() => resolveAtlassianCreds({} as never, () => null, notAuthorized)).toThrowError(
      expect.objectContaining({ code: 'not-configured' })
    )
    const noSite = resolveAtlassianCreds(reg({}), () => 'x', notAuthorized)
    expect(noSite.siteUrl).toBeNull()
    expect(noSite.token).toBeNull() // no apiToken secret-ref configured, so resolveSecret is never consulted
    const noToken = resolveAtlassianCreds(
      reg({ siteUrl: 'https://a.atlassian.net' }),
      () => null,
      notAuthorized
    )
    expect(noToken.siteUrl).toBe('https://a.atlassian.net')
    expect(noToken.token).toBeNull()
  })
})

describe('atlassianSiteUrl', () => {
  const reg = (cfg: Record<string, unknown>): ConnectorMap =>
    ({ rovo: { kind: 'http', preset: 'rovo', enabled: true, config: cfg } }) as never

  it('returns the trimmed siteUrl without requiring an API token (Open in Jira)', () => {
    expect(atlassianSiteUrl(reg({ siteUrl: 'https://acme.atlassian.net/' }))).toBe(
      'https://acme.atlassian.net'
    )
  })

  it('returns null with no rovo connector or no usable siteUrl', () => {
    expect(atlassianSiteUrl({} as never)).toBeNull()
    expect(atlassianSiteUrl(reg({}))).toBeNull()
    expect(atlassianSiteUrl(reg({ siteUrl: 'acme.atlassian.net' }))).toBeNull()
  })
})

describe('atlassianRestConfigured', () => {
  const reg = (cfg: Record<string, unknown>): ConnectorMap =>
    ({ rovo: { kind: 'http', preset: 'rovo', enabled: true, config: cfg } }) as never

  it('is false with no rovo connector or an untouched REST config (MCP-only usage)', () => {
    expect(atlassianRestConfigured({} as never, notAuthorized)).toBe(false)
    expect(
      atlassianRestConfigured(reg({ url: 'https://mcp.atlassian.com/x' }), notAuthorized)
    ).toBe(false)
    expect(atlassianRestConfigured(reg({ siteUrl: '   ' }), notAuthorized)).toBe(false)
  })

  it('is true once REST configuration has begun (siteUrl or token set)', () => {
    expect(
      atlassianRestConfigured(reg({ siteUrl: 'https://acme.atlassian.net' }), notAuthorized)
    ).toBe(true)
    expect(
      atlassianRestConfigured(
        reg({ apiToken: { $secret: 'connector/rovo/apiToken' } }),
        notAuthorized
      )
    ).toBe(true)
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
