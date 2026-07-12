import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { AtlassianClient, AtlassianError } from '../atlassian'

let server: http.Server
let base: string
const hits: string[] = []

const adf = (text: string): string =>
  JSON.stringify({
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    const url = req.url ?? ''
    const json = (body: unknown): void => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }
    if (url.startsWith('/wiki/rest/api/space/NAVNATIVE')) {
      json({ key: 'NAVNATIVE', name: 'Nav Native', homepage: { id: '100' } })
    } else if (url.startsWith('/wiki/rest/api/space/')) {
      res.statusCode = 404
      res.end('{}')
    } else if (url.startsWith('/wiki/rest/api/content/100/child/page')) {
      json({
        results: [
          {
            id: '101',
            title: 'Routing deep dive',
            version: { number: 3 },
            history: { lastUpdated: { when: '2026-07-01T00:00:00.000Z' } },
            children: { page: { size: 2 } }
          },
          { id: '102', title: 'Leaf', version: { number: 1 }, children: { page: { size: 0 } } }
        ]
      })
    } else if (
      url.startsWith('/wiki/rest/api/content/101?') &&
      url.includes('body.atlas_doc_format')
    ) {
      json({
        id: '101',
        title: 'Routing deep dive',
        version: { number: 3 },
        history: { lastUpdated: { when: '2026-07-01T00:00:00.000Z' } },
        children: { page: { size: 2 } },
        body: { atlas_doc_format: { value: adf('Cache request flow') } },
        _links: { base: base + '/wiki', webui: '/spaces/N/pages/101' }
      })
    } else if (url.startsWith('/wiki/rest/api/content/100?')) {
      json({ id: '100', title: 'Home', version: { number: 9 }, children: { page: { size: 2 } } })
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

const client = (): AtlassianClient =>
  new AtlassianClient(() => ({ instanceId: 'rovo', siteUrl: base, token: 'PAT123' }))

describe('confluence endpoints', () => {
  it('getConfluenceSpace resolves key/name/homepage', async () => {
    const s = await client().getConfluenceSpace('NAVNATIVE')
    expect(s).toEqual({ key: 'NAVNATIVE', name: 'Nav Native', homepageId: '100' })
  })

  it('unknown space maps to not-found', async () => {
    await expect(client().getConfluenceSpace('NOPE')).rejects.toMatchObject({
      code: 'not-found'
    } satisfies Partial<AtlassianError>)
  })

  it('children carry version, lastModified and hasChildren', async () => {
    const kids = await client().getConfluenceChildren('100')
    expect(kids).toEqual([
      {
        id: '101',
        title: 'Routing deep dive',
        version: 3,
        lastModified: '2026-07-01T00:00:00.000Z',
        hasChildren: true
      },
      { id: '102', title: 'Leaf', version: 1, lastModified: null, hasChildren: false }
    ])
  })

  it('getConfluencePage returns a single node', async () => {
    const n = await client().getConfluencePage('100')
    expect(n.id).toBe('100')
    expect(n.hasChildren).toBe(true)
  })

  it('page content converts ADF to markdown and builds the web url', async () => {
    const c = await client().getConfluencePageContent('101')
    expect(c.markdown).toContain('Cache request flow')
    expect(c.url).toBe(`${base}/wiki/spaces/N/pages/101`)
    expect(c.node.version).toBe(3)
  })
})
