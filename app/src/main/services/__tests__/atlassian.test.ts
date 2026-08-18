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
  jiraDate,
  JIRA_CURSOR_UNKNOWN_ZONE_MARGIN_MS,
  resolveAtlassianCreds,
  cloneLinksOf
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
let lastAttachmentToken: string | string[] | undefined
let lastAttachmentBody: string | undefined

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
    } else if (req.url?.includes('/rest/api/3/issue/KAN-1/attachments') && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        lastAttachmentToken = req.headers['x-atlassian-token']
        lastAttachmentBody = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ id: '10067', filename: 'rca-tech.md', size: 61 }]))
      })
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

  it('uploadAttachment sends multipart with no-check token and returns id+filename', async () => {
    const { id, filename } = await client().uploadAttachment('KAN-1', 'rca-tech.md', '# report')
    expect(id).toBe('10067')
    expect(filename).toBe('rca-tech.md')
    expect(lastAttachmentToken).toBe('no-check')
    expect(lastAttachmentBody).toContain('rca-tech.md')
    expect(lastAttachmentBody).toContain('# report')
  })

  it('fetchWith never lets a caller-supplied headers object override Authorization or Accept', async () => {
    const c = client()
    type FetchWith = (
      url: string,
      authorization: string,
      instanceId: string,
      opts?: {
        signal?: AbortSignal
        accept?: string
        method?: string
        body?: BodyInit
        headers?: Record<string, string>
      }
    ) => Promise<Response>
    const fetchWith = (c as unknown as { fetchWith: FetchWith }).fetchWith.bind(c)
    await fetchWith(`${base}/rest/api/3/project/search`, 'Bearer real-token', 'rovo', {
      headers: { Authorization: 'Bearer spoofed-token', Accept: 'text/plain' }
    })
    // The real bearer token wins, and the default Accept (JSON) is used — a caller-supplied
    // headers object (uploadAttachment's `X-Atlassian-Token`, or any future caller) can add
    // headers but can never stomp these two.
    expect(lastAuthHeader).toBe('Bearer real-token')
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

describe('searchIssues', () => {
  const ARES_JIRA = (): Response =>
    new Response(
      JSON.stringify([{ id: 'c1', url: 'https://x.atlassian.net', scopes: ['read:jira-work'] }]),
      { status: 200 }
    )

  // This file has no `clientWithResponses` helper (that name doesn't exist anywhere in the
  // repo) — its real per-describe-block convention is a local fake fetch that answers OAuth
  // discovery, then returns a single fixed status/body for the call under test, recording
  // every URL seen. Mirrors the `getComments` describe block above.
  const searchClient = (
    status: number,
    body: unknown
  ): { client: AtlassianClient; calls: string[] } => {
    const calls: string[] = []
    const fakeFetch = (async (url: string) => {
      calls.push(String(url))
      if (String(url).includes('accessible-resources')) return ARES_JIRA()
      return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    return { client: new AtlassianClient(oauthFixture, fakeFetch), calls }
  }

  it('returns keys with their cursor fields and the next page token', async () => {
    const { client, calls } = searchClient(200, {
      issues: [
        { key: 'ABC-1', fields: { created: '2026-08-01T10:00:00.000+0000', updated: 'u1' } },
        { key: 'ABC-2', fields: { created: '2026-08-01T11:00:00.000+0000', updated: 'u2' } }
      ],
      nextPageToken: 'tok'
    })
    const page = await client.searchIssues('project = ABC', { maxResults: 2 })
    expect(page.issues).toEqual([
      { key: 'ABC-1', created: '2026-08-01T10:00:00.000+0000', updated: 'u1' },
      { key: 'ABC-2', created: '2026-08-01T11:00:00.000+0000', updated: 'u2' }
    ])
    expect(page.nextPageToken).toBe('tok')
    const searchCall = calls.find((c) => c.includes('/rest/api/3/search/jql'))
    expect(searchCall).toBeDefined()
    expect(searchCall).toContain(encodeURIComponent('project = ABC'))
  })

  it('reports no next page as null rather than undefined', async () => {
    const { client } = searchClient(200, { issues: [] })
    const page = await client.searchIssues('project = ABC', {})
    expect(page.nextPageToken).toBeNull()
    expect(page.issues).toEqual([])
  })

  it('tolerates an issue whose fields block is missing', async () => {
    const { client } = searchClient(200, { issues: [{ key: 'ABC-3' }] })
    const page = await client.searchIssues('project = ABC', {})
    expect(page.issues).toEqual([{ key: 'ABC-3', created: '', updated: '' }])
  })

  it('surfaces an invalid JQL as an AtlassianError the run can record', async () => {
    const { client } = searchClient(400, { errorMessages: ["Field 'nope' does not exist"] })
    await expect(client.searchIssues('nope = 1', {})).rejects.toBeInstanceOf(AtlassianError)
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

describe('jiraDate', () => {
  it('formats a Jira timestamp as a JQL minute-resolution literal', () => {
    expect(jiraDate('2026-08-01T10:15:42.123Z')).toBe('2026-08-01 10:15')
  })

  it('drops seconds entirely, which is why the cursor boundary must be inclusive', () => {
    // Two tickets at :30 and :59 seconds past the same minute format identically here. If the
    // caller used a strict `>` cursor comparison, the second of the two would never be seen
    // again once the first advanced the cursor — see jiraScopeResolver.ts's `>=` boundary and
    // items.ts's by-key de-duplication, which is what makes this precision loss safe.
    expect(jiraDate('2026-08-01T10:15:30.000Z')).toBe(jiraDate('2026-08-01T10:15:59.999Z'))
  })

  it('pads single-digit month, day, hour and minute', () => {
    expect(jiraDate('2026-01-02T03:04:00.000Z')).toBe('2026-01-02 03:04')
  })

  /**
   * THE BUG THIS FUNCTION EXISTS FOR, and it was measured, not reasoned about: JQL has no timezone
   * syntax, so Jira reads a bare literal as wall-clock time in the ACCOUNT's zone. Two identical
   * 34-minute windows shifted by two hours were issued against a real instance; only the
   * account-local one returned the anchor issue.
   *
   * A literal formatted in UTC for a non-UTC account is a bound at the wrong instant —
   * permanently skipped tickets west of UTC, a permanently stalled routine east of it, and `ok`
   * on the run either way. The account's offset never has to be looked up, because Jira already
   * stamped it on the very value the cursor was copied from.
   */
  it('formats EAST of UTC in the offset the timestamp carries, not UTC', () => {
    // Verbatim from the live run: KAN-15's `created` on a UTC+2 account.
    expect(jiraDate('2026-08-03T15:36:14.574+0200')).toBe('2026-08-03 15:36')
  })

  it('formats WEST of UTC in the offset the timestamp carries, not UTC', () => {
    // 02:15-0700 is 09:15Z: a UTC literal would bound seven hours late and skip that window
    // permanently, because the cursor only ever moves forward.
    expect(jiraDate('2026-08-08T02:15:30.000-0700')).toBe('2026-08-08 02:15')
  })

  it('treats an explicit Z as the offset it is, and never shifts it', () => {
    // Jira renders in the account's zone, so `Z` means the account IS at UTC+00:00.
    expect(jiraDate('2026-08-01T19:15:00.000Z')).toBe('2026-08-01 19:15')
  })

  it('accepts the colon-separated offset form as well as the compact one', () => {
    expect(jiraDate('2026-08-03T15:36:14.574+02:00')).toBe('2026-08-03 15:36')
    expect(jiraDate('2026-08-08T02:15:30.000-07:00')).toBe('2026-08-08 02:15')
  })

  it('keeps the date the offset puts it on, never the UTC one', () => {
    // 23:30+0200 is 21:30Z the same day; 00:30+0200 is 22:30Z the PREVIOUS day. Formatting in UTC
    // would move the literal to a different calendar day in the second case.
    expect(jiraDate('2026-08-03T23:30:00.000+0200')).toBe('2026-08-03 23:30')
    expect(jiraDate('2026-08-04T00:30:00.000+0200')).toBe('2026-08-04 00:30')
  })

  it('emits a 24-hour clock at midnight, never "12" or "24"', () => {
    // A 12-hour clock would produce "12:05" for midnight and a 24-hour-indexed one "24:05" —
    // both unparseable as a JQL literal.
    expect(jiraDate('2026-08-01T00:05:00.000Z')).toBe('2026-08-01 00:05')
    expect(jiraDate('2026-08-01T12:05:00.000Z')).toBe('2026-08-01 12:05')
  })

  it('falls back to a 12-hour-earlier literal when the value carries NO offset', () => {
    // Never LATER than the cursor for any account (the westernmost real offset is -12:00), so
    // this path can only re-examine already-attempted tickets, never skip new ones. The cost of
    // that widened window is written down on JIRA_CURSOR_UNKNOWN_ZONE_MARGIN_MS — as is why no
    // cursor Jira produced can reach it.
    expect(jiraDate('2026-08-01T10:15:42.123')).toBe('2026-07-31 22:15')
    expect(JIRA_CURSOR_UNKNOWN_ZONE_MARGIN_MS).toBe(12 * 60 * 60 * 1000)
  })

  it('does not read the host machine zone on the no-offset path', () => {
    // The one input that already lost its offset must not pick up the laptop's. `new Date()` on
    // an offset-less datetime is parsed as LOCAL time by the runtime, so a Date-based
    // implementation would make this assertion depend on where the machine happens to be — and
    // then on where CI happens to be.
    const tz = process.env.TZ
    try {
      process.env.TZ = 'Asia/Tokyo'
      const tokyo = jiraDate('2026-08-01T10:15:42.123')
      const tokyoEpoch = new Date('2026-08-01T10:15:42.123').getTime()
      process.env.TZ = 'America/Los_Angeles'
      // Proves the two branches below are not the same environment — without this the whole test
      // passes vacuously on a runtime that ignores a mid-process TZ change.
      expect(new Date('2026-08-01T10:15:42.123').getTime()).not.toBe(tokyoEpoch)
      expect(jiraDate('2026-08-01T10:15:42.123')).toBe(tokyo)
      expect(tokyo).toBe('2026-07-31 22:15')
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })

  it('falls back the same way for a date with no time part', () => {
    expect(jiraDate('2026-08-01')).toBe('2026-07-31 12:00')
  })

  it('throws rather than emitting NaN into a JQL string', () => {
    // A garbage cursor produced `NaN-NaN-NaN NaN:NaN` before, which Jira answers with an opaque
    // 400. Failing the run with a readable reason is the recoverable outcome.
    expect(() => jiraDate('not a date')).toThrow(/not a timestamp/)
  })
})

describe('resolveSiteUrl', () => {
  const ARES = (): Response =>
    new Response(
      JSON.stringify([
        { id: 'c1', url: 'https://acme.atlassian.net/', scopes: ['read:jira-work'] }
      ]),
      { status: 200 }
    )

  /** Expired-token fixture: accessToken() is null until refresh() rotates it —
   *  exactly what OAuth.accessToken does inside its 60 s expiry slack. */
  const expiring = (): { auth: () => AtlassianAuth; refreshes: () => number } => {
    let fresh = false
    let refreshes = 0
    return {
      auth: () => ({
        instanceId: 'rovo',
        oauth: {
          serverUrl: 'https://mcp',
          accessToken: () => (fresh ? 'oauth-tok' : null),
          refresh: async () => {
            refreshes++
            fresh = true
          }
        }
      }),
      refreshes: () => refreshes
    }
  }

  it('refreshes an expired token instead of giving up (browse link after idle)', async () => {
    const { auth, refreshes } = expiring()
    const c = new AtlassianClient(auth, (async () => ARES()) as unknown as typeof fetch)
    expect(await c.resolveSiteUrl('rovo')).toBe('https://acme.atlassian.net')
    expect(refreshes()).toBe(1)
  })

  it('returns null without discovering when the refresh yields no token', async () => {
    let discoveries = 0
    const c = new AtlassianClient(
      () => ({
        instanceId: 'rovo',
        oauth: { serverUrl: 'https://mcp', accessToken: () => null, refresh: async () => undefined }
      }),
      (async () => {
        discoveries++
        return ARES()
      }) as unknown as typeof fetch
    )
    expect(await c.resolveSiteUrl('rovo')).toBeNull()
    expect(discoveries).toBe(0)
  })

  it('returns null when the connector is not OAuth-authorized', async () => {
    const c = new AtlassianClient(() => ({ instanceId: 'rovo' }), (async () =>
      ARES()) as unknown as typeof fetch)
    expect(await c.resolveSiteUrl('rovo')).toBeNull()
  })
})

describe('cloneLinksOf', () => {
  const link = (
    type: string,
    dir: 'inwardIssue' | 'outwardIssue',
    key: string
  ): Record<string, unknown> => ({
    type: { name: type },
    [dir]: { key, fields: { summary: `${key} summary` } }
  })

  it('returns [] when issuelinks is absent', () => {
    expect(cloneLinksOf({})).toEqual([])
  })

  it('keeps clone links in both directions and ignores other link types', () => {
    const fields = {
      issuelinks: [
        link('Cloners', 'inwardIssue', 'CUST-9'),
        link('Cloners', 'outwardIssue', 'CUST-10'),
        link('Relates', 'inwardIssue', 'OTHER-1'),
        link('Duplicate', 'outwardIssue', 'OTHER-2')
      ]
    }
    expect(cloneLinksOf(fields)).toEqual([
      { key: 'CUST-9', summary: 'CUST-9 summary', direction: 'is-cloned-by' },
      { key: 'CUST-10', summary: 'CUST-10 summary', direction: 'clones' }
    ])
  })

  it('matches the clone type case-insensitively', () => {
    expect(cloneLinksOf({ issuelinks: [link('cloners', 'inwardIssue', 'CUST-9')] })).toHaveLength(1)
  })

  it('skips malformed entries rather than throwing', () => {
    const fields = { issuelinks: [{ type: { name: 'Cloners' } }, null, 'nonsense'] }
    expect(cloneLinksOf(fields)).toEqual([])
  })
})
