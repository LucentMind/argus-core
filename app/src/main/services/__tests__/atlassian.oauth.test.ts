import { describe, it, expect } from 'vitest'
import {
  discoverJiraCloud,
  AtlassianError,
  resolveAtlassianCreds,
  AtlassianClient
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

describe('discoverJiraCloud', () => {
  it('picks the jira-work resource and returns cloudId + siteUrl', async () => {
    const c = await discoverJiraCloud('tok', fetchReturning(200, RESOURCES), 15000)
    expect(c).toEqual({ cloudId: 'cloud-1', siteUrl: 'https://argus88.atlassian.net' })
  })

  it('throws auth error on non-200', async () => {
    await expect(
      discoverJiraCloud('tok', fetchReturning(401, { message: 'nope' }), 15000)
    ).rejects.toBeInstanceOf(AtlassianError)
  })

  it('throws when no jira-work resource is present', async () => {
    const only = [{ id: 'x', url: 'https://x', scopes: ['read:page:confluence'] }]
    await expect(discoverJiraCloud('tok', fetchReturning(200, only), 15000)).rejects.toBeInstanceOf(
      AtlassianError
    )
  })

  it('throws AtlassianError on invalid JSON response body', async () => {
    const invalidJsonFetch = (async () =>
      new Response('not json{', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch
    const err = await discoverJiraCloud('tok', invalidJsonFetch, 15000).catch((e) => e)
    expect(err).toBeInstanceOf(AtlassianError)
    expect(err.code).toBe('http')
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
      oauth: true,
      siteUrl: 'https://argus88.atlassian.net',
      email: 'me@x.com',
      apiToken: { $secret: 'connector/rovo/apiToken' }
    }
  }
} as unknown as ConnectorMap

const fakeOAuth = (authorized: boolean): OAuthLike => ({
  status: () => (authorized ? 'authorized' : 'not-authorized'),
  accessToken: () => (authorized ? 'oauth-tok' : null),
  refresh: async () => authorized
})

describe('resolveAtlassianCreds (mode-aware)', () => {
  it('exposes oauth block when authorized', () => {
    const a = resolveAtlassianCreds(ROVO, () => 'REST-TOKEN', fakeOAuth(true))
    expect(a.oauth).toBeTruthy()
    expect(a.oauth!.accessToken()).toBe('oauth-tok')
    expect(a.oauth!.serverUrl).toBe('https://mcp.atlassian.com/v1/mcp/authv2')
    expect(a.token).toBe('REST-TOKEN')
  })

  it('no oauth block when not authorized; token still present', () => {
    const a = resolveAtlassianCreds(ROVO, () => 'REST-TOKEN', fakeOAuth(false))
    expect(a.oauth).toBeUndefined()
    expect(a.token).toBe('REST-TOKEN')
  })

  it('does not throw when token is missing (oauth-only)', () => {
    const a = resolveAtlassianCreds(ROVO, () => null, fakeOAuth(true))
    expect(a.token).toBeNull()
    expect(a.oauth).toBeTruthy()
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
const ARES = (): Response =>
  new Response(
    JSON.stringify([
      { id: 'cloud-1', url: 'https://argus88.atlassian.net', scopes: ['read:jira-work'] }
    ]),
    { status: 200 }
  )
const OK = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
const ISSUE_BODY = { key: 'KAN-2', fields: { summary: 's', attachment: [] } }

function authFixture(over: Partial<AtlassianAuth>): () => AtlassianAuth {
  return () => ({
    instanceId: 'rovo',
    siteUrl: 'https://legacy.example',
    token: 'REST-TOKEN',
    email: 'me@x.com',
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

  it('Jira path without OAuth → legacy siteUrl + Basic', async () => {
    const { impl, calls } = recordingFetch([() => OK(ISSUE_BODY)])
    const c = new AtlassianClient(authFixture({ oauth: undefined }), impl)
    await c.getIssue('KAN-2')
    expect(calls[0].url.startsWith('https://legacy.example/rest/api/3/issue/')).toBe(true)
    expect(calls[0].auth!.startsWith('Basic ')).toBe(true)
  })

  it('Confluence path always uses legacy token even when OAuth present', async () => {
    const { impl, calls } = recordingFetch([() => OK({ key: 'SP', name: 'Space' })])
    const c = new AtlassianClient(authFixture({}), impl)
    await c.getConfluenceSpace('SP')
    expect(calls[0].url.startsWith('https://legacy.example/wiki/')).toBe(true)
    expect(calls[0].auth!.startsWith('Basic ')).toBe(true)
  })

  it('401 on OAuth Jira → refresh once → retry; still 401 → falls back to legacy token', async () => {
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
    const { impl, calls } = recordingFetch([ARES, un, un, () => OK(ISSUE_BODY)]) // ares, try, retry(401), legacy ok
    const c = new AtlassianClient(auth, impl)
    await c.getIssue('KAN-2')
    expect(refreshed).toBe(1)
    expect(calls[calls.length - 1].url.startsWith('https://legacy.example/')).toBe(true)
  })

  it('no oauth and no token → no-token error', async () => {
    const { impl } = recordingFetch([() => OK(ISSUE_BODY)])
    const c = new AtlassianClient(
      authFixture({ oauth: undefined, token: null, siteUrl: null }),
      impl
    )
    await expect(c.getIssue('KAN-2')).rejects.toMatchObject({ code: 'no-token' })
  })

  it('Jira path with oauth undefined AND siteUrl null (token present) → no-token, not a network error', async () => {
    const { impl } = recordingFetch([() => OK(ISSUE_BODY)])
    const c = new AtlassianClient(
      authFixture({ oauth: undefined, siteUrl: null, token: 'REST-TOKEN' }),
      impl
    )
    const err = await c.getIssue('KAN-2').catch((e) => e)
    expect(err).toBeInstanceOf(AtlassianError)
    expect(err.code).toBe('no-token')
  })
})
