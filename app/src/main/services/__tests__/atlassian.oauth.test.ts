import { describe, it, expect } from 'vitest'
import {
  discoverCloud,
  AtlassianError,
  resolveAtlassianCreds,
  AtlassianClient,
  atlassianRestConfigured
} from '../atlassian'
import type { ConnectorMap } from '../../../shared/connectors'
import type { OAuthLike, AtlassianAuth } from '../atlassian'

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch
}

const RESOURCES = [
  { id: 'cloud-1', url: 'https://argus88.atlassian.net', scopes: ['read:page:confluence'] },
  {
    id: 'cloud-1',
    url: 'https://argus88.atlassian.net',
    scopes: ['read:jira-work', 'write:jira-work']
  }
]

describe('discoverCloud (jira product, replaces the removed discoverJiraCloud alias)', () => {
  it('picks the jira-work resource and returns cloudId + siteUrl', async () => {
    const c = await discoverCloud('tok', 'jira', fetchReturning(200, RESOURCES), 15000)
    expect(c).toEqual({ cloudId: 'cloud-1', siteUrl: 'https://argus88.atlassian.net' })
  })

  it('throws auth error on non-200', async () => {
    await expect(
      discoverCloud('tok', 'jira', fetchReturning(401, { message: 'nope' }), 15000)
    ).rejects.toBeInstanceOf(AtlassianError)
  })

  it('throws when no jira-work resource is present', async () => {
    const only = [{ id: 'x', url: 'https://x', scopes: ['read:page:confluence'] }]
    await expect(
      discoverCloud('tok', 'jira', fetchReturning(200, only), 15000)
    ).rejects.toBeInstanceOf(AtlassianError)
  })

  it('throws AtlassianError on invalid JSON response body', async () => {
    const invalidJsonFetch = (async () =>
      new Response('not json{', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch
    const err = await discoverCloud('tok', 'jira', invalidJsonFetch, 15000).catch((e) => e)
    expect(err).toBeInstanceOf(AtlassianError)
    expect(err.code).toBe('http')
  })
})

const RES = [
  {
    id: 'c1',
    url: 'https://argus88.atlassian.net',
    scopes: ['read:page:confluence', 'read:space:confluence']
  },
  {
    id: 'c1',
    url: 'https://argus88.atlassian.net',
    scopes: ['read:jira-work']
  }
]
const fetch200 = (b: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(b), { status: 200 })) as unknown as typeof fetch

describe('discoverCloud', () => {
  it('selects the confluence resource for product=confluence', async () => {
    expect(await discoverCloud('t', 'confluence', fetch200(RES), 15000)).toEqual({
      cloudId: 'c1',
      siteUrl: 'https://argus88.atlassian.net'
    })
  })
  it('selects the jira resource for product=jira', async () => {
    expect(await discoverCloud('t', 'jira', fetch200(RES), 15000)).toEqual({
      cloudId: 'c1',
      siteUrl: 'https://argus88.atlassian.net'
    })
  })
  it('throws auth when the product scope is absent', async () => {
    const only = [{ id: 'x', url: 'https://x', scopes: ['read:jira-work'] }]
    await expect(discoverCloud('t', 'confluence', fetch200(only), 15000)).rejects.toMatchObject({
      code: 'auth'
    })
  })
})

const ROVO: ConnectorMap = {
  rovo: {
    preset: 'rovo',
    enabled: true,
    displayName: 'Rovo',
    config: {
      url: 'https://mcp.atlassian.com/v1/mcp/authv2',
      transport: 'http',
      oauth: true
    }
  }
} as unknown as ConnectorMap

const fakeOAuth = (authorized: boolean): OAuthLike => ({
  status: () => (authorized ? 'authorized' : 'not-authorized'),
  accessToken: () => (authorized ? 'oauth-tok' : null),
  refresh: async () => authorized
})

describe('resolveAtlassianCreds (OAuth-only)', () => {
  it('exposes an oauth block iff authorized', () => {
    const a = resolveAtlassianCreds(ROVO, fakeOAuth(true))
    expect(a.oauth).toBeTruthy()
    expect(a.oauth!.accessToken()).toBe('oauth-tok')
    expect(a.oauth!.serverUrl).toBe('https://mcp.atlassian.com/v1/mcp/authv2')
  })

  it('no oauth block when not authorized', () => {
    const a = resolveAtlassianCreds(ROVO, fakeOAuth(false))
    expect(a.oauth).toBeUndefined()
  })

  it('throws not-configured when no rovo connector exists', () => {
    expect(() => resolveAtlassianCreds({} as never, fakeOAuth(true))).toThrowError(
      expect.objectContaining({ code: 'not-configured' })
    )
  })
})

// records the URLs + auth headers fetch was called with
function recordingFetch(handlers: Array<(url: string) => Response>): {
  impl: typeof fetch
  calls: { url: string; auth: string | null }[]
} {
  const calls: { url: string; auth: string | null }[] = []
  let i = 0
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization ?? null })
    const h = handlers[Math.min(i, handlers.length - 1)]
    i++
    return h(url)
  }) as unknown as typeof fetch
  return { impl, calls }
}
// Same site (cloud-1), both products' scopes present — a real accessible-resources
// response lists one entry per granted scope-set, not one per product.
const ARES = (): Response =>
  new Response(
    JSON.stringify([
      { id: 'cloud-1', url: 'https://argus88.atlassian.net', scopes: ['read:jira-work'] },
      {
        id: 'cloud-1',
        url: 'https://argus88.atlassian.net',
        scopes: ['read:page:confluence', 'read:space:confluence']
      }
    ]),
    { status: 200 }
  )
const OK = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
const ISSUE_BODY = { key: 'KAN-2', fields: { summary: 's', attachment: [] } }

function authFixture(over: Partial<AtlassianAuth>): () => AtlassianAuth {
  return () => ({
    instanceId: 'rovo',
    oauth: {
      serverUrl: 'https://mcp',
      accessToken: () => 'oauth-tok',
      refresh: async () => undefined
    },
    ...over
  })
}

describe('AtlassianClient.request routing', () => {
  it('Jira path with OAuth → gateway URL + Bearer, cloudId discovered once', async () => {
    const { impl, calls } = recordingFetch([ARES, () => OK(ISSUE_BODY), () => OK(ISSUE_BODY)])
    const c = new AtlassianClient(authFixture({}), impl)
    await c.getIssue('KAN-2')
    await c.getIssue('KAN-2')
    const jiraCalls = calls.filter((x) => x.url.includes('/ex/jira/'))
    expect(jiraCalls[0].url).toBe(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/KAN-2?fields=summary,description,status,labels,reporter,created,updated,attachment'
    )
    expect(jiraCalls[0].auth).toBe('Bearer oauth-tok')
    expect(calls.filter((x) => x.url.includes('accessible-resources'))).toHaveLength(1) // cached
  })

  it('invalidateCloud drops the cached cloudId so the next call re-discovers it', async () => {
    const { impl, calls } = recordingFetch([ARES, () => OK(ISSUE_BODY), ARES, () => OK(ISSUE_BODY)])
    const c = new AtlassianClient(authFixture({}), impl)
    await c.getIssue('KAN-2')
    c.invalidateCloud('rovo')
    await c.getIssue('KAN-2')
    expect(calls.filter((x) => x.url.includes('accessible-resources'))).toHaveLength(2)
  })

  it('Jira path without OAuth → auth error', async () => {
    const { impl, calls } = recordingFetch([() => OK(ISSUE_BODY)])
    const c = new AtlassianClient(authFixture({ oauth: undefined }), impl)
    const err = await c.getIssue('KAN-2').catch((e) => e)
    expect(err).toBeInstanceOf(AtlassianError)
    expect(err.code).toBe('auth')
    expect(calls).toHaveLength(0) // never hits the network — no oauth block, nothing to try
  })

  it('Confluence routes to the /ex/confluence gateway with Bearer', async () => {
    const { impl, calls } = recordingFetch([
      ARES,
      () => OK({ results: [{ key: 'SP', name: 'S', homepageId: '1' }] })
    ])
    const c = new AtlassianClient(authFixture({}), impl)
    await c.getConfluenceSpace('SP')
    const g = calls.find((x) => x.url.includes('/ex/confluence/'))
    expect(g).toBeTruthy()
    expect(g!.url).toContain('/wiki/api/v2/spaces?keys=SP')
    expect(g!.auth).toBe('Bearer oauth-tok')
  })

  it('401 on OAuth Jira → refresh once → retry; still 401 → auth error', async () => {
    let refreshed = 0
    const auth = authFixture({
      oauth: {
        serverUrl: 'https://mcp',
        accessToken: () => 'oauth-tok',
        refresh: async () => {
          refreshed++
        }
      }
    })
    const un = (): Response => new Response('{}', { status: 401 })
    const { impl } = recordingFetch([ARES, un, un]) // ares, try(401), retry(401)
    const c = new AtlassianClient(auth, impl)
    const err = await c.getIssue('KAN-2').catch((e) => e)
    expect(refreshed).toBe(1)
    expect(err).toBeInstanceOf(AtlassianError)
    expect(err.code).toBe('auth')
  })

  it('accessToken() null → refresh → still null → auth error', async () => {
    const { impl, calls } = recordingFetch([() => OK(ISSUE_BODY)])
    const c = new AtlassianClient(
      authFixture({
        oauth: {
          serverUrl: 'https://mcp',
          accessToken: () => null,
          refresh: async () => undefined
        }
      }),
      impl
    )
    const err = await c.getIssue('KAN-2').catch((e) => e)
    expect(err).toBeInstanceOf(AtlassianError)
    expect(err.code).toBe('auth')
    expect(calls).toHaveLength(0) // never reaches discovery/fetch — no valid token
  })

  it('OAuth 401 twice → auth error', async () => {
    const { impl } = recordingFetch([
      ARES,
      () => new Response('{}', { status: 401 }),
      () => new Response('{}', { status: 401 })
    ])
    const c = new AtlassianClient(authFixture({}), impl)
    const err = await c.getIssue('KAN-2').catch((e) => e)
    expect(err).toBeInstanceOf(AtlassianError)
    expect(err.code).toBe('auth')
  })

  it('cloud discovery fails (accessible-resources 401) → auth error', async () => {
    const { impl } = recordingFetch([() => new Response('{}', { status: 401 })])
    const c = new AtlassianClient(authFixture({}), impl)
    const err = await c.getIssue('KAN-2').catch((e) => e)
    expect(err).toBeInstanceOf(AtlassianError)
    expect(err.code).toBe('auth')
  })
})

describe('health', () => {
  it('probeJira hits project/search', async () => {
    const { impl, calls } = recordingFetch([ARES, () => OK({ values: [] })])
    const c = new AtlassianClient(authFixture({}), impl)
    await c.probeJira()
    expect(calls.some((x) => x.url.includes('/rest/api/3/project/search'))).toBe(true)
  })

  it('atlassianRestConfigured true for OAuth-only (no token/siteUrl)', () => {
    const conn = {
      rovo: {
        preset: 'rovo',
        enabled: true,
        config: { url: 'https://mcp', transport: 'http', oauth: true }
      }
    } as unknown as ConnectorMap
    expect(atlassianRestConfigured(conn, fakeOAuth(true))).toBe(true)
    expect(atlassianRestConfigured(conn, fakeOAuth(false))).toBe(false)
  })

  it('atlassianRestConfigured true for OAuth status "error" (no token/siteUrl) — Health row must not vanish', () => {
    const conn = {
      rovo: {
        preset: 'rovo',
        enabled: true,
        config: { url: 'https://mcp', transport: 'http', oauth: true }
      }
    } as unknown as ConnectorMap
    const erroredOAuth: OAuthLike = {
      status: () => 'error',
      accessToken: () => null,
      refresh: async () => false
    }
    expect(atlassianRestConfigured(conn, erroredOAuth)).toBe(true)
  })
})
