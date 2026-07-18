import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { AtlassianClient, AtlassianError } from '../atlassian'
import type { AtlassianAuth } from '../atlassian'

let server: http.Server
let base: string
const hits: string[] = []

const adf = (text: string): string =>
  JSON.stringify({
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

// cloudId the fake accessible-resources response advertises; the gateway URL the
// client builds (${GATEWAY}/ex/confluence/{cloudId}...) is rewritten below to hit
// this test server instead of the real api.atlassian.com gateway.
const CLOUD_ID = 'cloud-conf-1'

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    const url = req.url ?? ''
    const json = (body: unknown): void => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }
    if (url.startsWith('/oauth/token/accessible-resources')) {
      json([{ id: CLOUD_ID, url: base, scopes: ['read:page:confluence', 'read:space:confluence'] }])
    } else if (url.startsWith(`/ex/confluence/${CLOUD_ID}/wiki/api/v2/spaces?keys=NAVNATIVE`)) {
      json({ results: [{ id: '900', key: 'NAVNATIVE', name: 'Nav Native', homepageId: '100' }] })
    } else if (url.startsWith(`/ex/confluence/${CLOUD_ID}/wiki/api/v2/spaces?keys=`)) {
      json({ results: [] })
    } else if (
      url.startsWith(`/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/100/children`) &&
      !url.includes('cursor=')
    ) {
      // first page of children — carries only id/title (+status/spaceId/childPosition),
      // and a _links.next cursor path pointing at the second page.
      json({
        results: [{ id: '101', title: 'Routing deep dive', status: 'current' }],
        _links: {
          next: `/wiki/api/v2/pages/100/children?limit=250&cursor=CURSOR_2`
        }
      })
    } else if (
      url.startsWith(`/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/100/children`) &&
      url.includes('cursor=CURSOR_2')
    ) {
      // second (final) page — no _links.next, so the client must stop here.
      json({ results: [{ id: '102', title: 'Leaf', status: 'current' }] })
    } else if (
      url.startsWith(`/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/101?`) &&
      url.includes('body-format=atlas_doc_format')
    ) {
      json({
        id: '101',
        title: 'Routing deep dive',
        version: { number: 3, createdAt: '2026-07-01T00:00:00.000Z' },
        body: { atlas_doc_format: { value: adf('Cache request flow') } },
        _links: { base: base + '/wiki', webui: '/spaces/N/pages/101' }
      })
    } else if (url === `/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/101`) {
      json({
        id: '101',
        title: 'Routing deep dive',
        version: { number: 3, createdAt: '2026-07-01T00:00:00.000Z' },
        _links: { base: base + '/wiki', webui: '/spaces/N/pages/101' }
      })
    } else if (url === `/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/102`) {
      json({
        id: '102',
        title: 'Leaf',
        version: { number: 1, createdAt: '2026-06-01T00:00:00.000Z' },
        _links: { base: base + '/wiki', webui: '/spaces/N/pages/102' }
      })
    } else if (url === `/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/100`) {
      json({
        id: '100',
        title: 'Home',
        version: { number: 9, createdAt: '2026-05-01T00:00:00.000Z' },
        _links: { base: base + '/wiki', webui: '/spaces/N/overview' }
      })
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(() => server.close())

// Points the gateway fetch at the test http.Server: GATEWAY is a fixed constant
// (https://api.atlassian.com) baked into atlassian.ts, so the fixture rewrites
// any request aimed at it to `base` instead, keeping the client code untouched.
const gatewayFetch = (): typeof fetch =>
  ((url: string, init: RequestInit) => {
    const rewritten = url.replace('https://api.atlassian.com', base)
    return fetch(rewritten, init)
  }) as unknown as typeof fetch

const authFixture = (): AtlassianAuth => ({
  instanceId: 'rovo',
  oauth: {
    serverUrl: 'https://mcp',
    accessToken: () => 'oauth-tok',
    refresh: async () => undefined
  }
})

const client = (): AtlassianClient => new AtlassianClient(authFixture, gatewayFetch())

describe('confluence endpoints (v2 over OAuth gateway)', () => {
  it('getConfluenceSpace resolves key/name/homepage via /ex/confluence gateway', async () => {
    const s = await client().getConfluenceSpace('NAVNATIVE')
    expect(s).toEqual({ key: 'NAVNATIVE', name: 'Nav Native', homepageId: '100' })
    expect(hits.some((h) => h.includes('/wiki/api/v2/spaces?keys=NAVNATIVE'))).toBe(true)
  })

  it('unknown space maps to not-found', async () => {
    await expect(client().getConfluenceSpace('NOPE')).rejects.toMatchObject({
      code: 'not-found'
    } satisfies Partial<AtlassianError>)
  })

  it('children follow the _links.next cursor across pages (the >200 fix) and N+1-fetch each full page', async () => {
    const kids = await client().getConfluenceChildren('100')
    expect(kids).toEqual([
      {
        id: '101',
        title: 'Routing deep dive',
        version: 3,
        lastModified: '2026-07-01T00:00:00.000Z',
        hasChildren: true
      },
      {
        id: '102',
        title: 'Leaf',
        version: 1,
        lastModified: '2026-06-01T00:00:00.000Z',
        hasChildren: true
      }
    ])
    // both cursor pages were actually requested
    expect(
      hits.some((h) => h.includes('/pages/100/children?limit=250') && !h.includes('cursor='))
    ).toBe(true)
    expect(hits.some((h) => h.includes('cursor=CURSOR_2'))).toBe(true)
    // N+1: each child's full page was fetched individually
    expect(hits.some((h) => h === '/ex/confluence/cloud-conf-1/wiki/api/v2/pages/101')).toBe(true)
    expect(hits.some((h) => h === '/ex/confluence/cloud-conf-1/wiki/api/v2/pages/102')).toBe(true)
  })

  it('getConfluencePage returns a single node; hasChildren always true (no v2 leaf signal)', async () => {
    const n = await client().getConfluencePage('100')
    expect(n.id).toBe('100')
    expect(n.version).toBe(9)
    expect(n.hasChildren).toBe(true)
  })

  it('page content converts ADF to markdown and builds the web url from _links.base + _links.webui', async () => {
    const c = await client().getConfluencePageContent('101')
    expect(c.markdown).toContain('Cache request flow')
    expect(c.url).toBe(`${base}/wiki/spaces/N/pages/101`)
    expect(c.node.version).toBe(3)
    expect(c.node.lastModified).toBe('2026-07-01T00:00:00.000Z')
  })
})
