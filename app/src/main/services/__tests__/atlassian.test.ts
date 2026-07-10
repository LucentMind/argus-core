import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AtlassianClient, AtlassianError, resolveAtlassianCreds } from '../atlassian'
import type { ConnectorMap } from '../../../shared/connectors'

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
    if (req.url?.startsWith('/rest/api/3/issue/NAV-7')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ISSUE))
    } else if (req.url?.startsWith('/rest/api/3/issue/GONE-1')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    } else if (req.url?.startsWith('/rest/api/3/issue/SECRET-1')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{}')
    } else if (req.url?.startsWith('/rest/api/3/attachment/content/10001')) {
      // Jira answers the content endpoint with a redirect to the media host
      res.writeHead(303, { location: `${mediaBase}/blob/10001` })
      res.end()
    } else if (req.url?.startsWith('/rest/api/3/myself')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ displayName: 'Ada' }))
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

const client = (): AtlassianClient =>
  new AtlassianClient(() => ({ instanceId: 'rovo', siteUrl: base, token: 'PAT123' }))

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
      (n) => (n === 'connector/rovo/apiToken' ? 'PAT123' : null)
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
      () => 'PAT123'
    )
    expect(withEmail.email).toBe('ada@acme.test')
    const blank = resolveAtlassianCreds(
      reg({
        siteUrl: 'https://acme.atlassian.net',
        email: '   ',
        apiToken: { $secret: 'connector/rovo/apiToken' }
      }),
      () => 'PAT123'
    )
    expect(blank.email).toBeUndefined()
  })

  it('throws typed errors: not-configured / no-site-url / no-token', () => {
    expect(() => resolveAtlassianCreds({} as never, () => null)).toThrowError(
      expect.objectContaining({ code: 'not-configured' })
    )
    expect(() => resolveAtlassianCreds(reg({}), () => 'x')).toThrowError(
      expect.objectContaining({ code: 'no-site-url' })
    )
    expect(() =>
      resolveAtlassianCreds(reg({ siteUrl: 'https://a.atlassian.net' }), () => null)
    ).toThrowError(expect.objectContaining({ code: 'no-token', instanceId: 'rovo' }))
  })
})

describe('AtlassianClient', () => {
  it('getIssue maps fields, converts the ADF description, sends Bearer auth', async () => {
    const { preview, descriptionMarkdown, raw } = await client().getIssue('NAV-7')
    expect(lastAuthHeader).toBe('Bearer PAT123')
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

  it('sends Basic auth (email:token) when the creds carry an email — the Jira Cloud path', async () => {
    const basic = new AtlassianClient(() => ({
      instanceId: 'rovo',
      siteUrl: base,
      token: 'PAT123',
      email: 'ada@acme.test'
    }))
    await basic.myself()
    expect(lastAuthHeader).toBe(`Basic ${Buffer.from('ada@acme.test:PAT123').toString('base64')}`)
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
    const dead = new AtlassianClient(
      () => ({ instanceId: 'rovo', siteUrl: 'http://127.0.0.1:9', token: 'x' }),
      fetch,
      2000
    )
    await expect(dead.getIssue('NAV-7')).rejects.toMatchObject({ code: 'network' })
  })

  it('AtlassianError is an Error with code', () => {
    const e = new AtlassianError('http', 'boom', 'rovo')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('http')
    expect(e.instanceId).toBe('rovo')
  })
})
