import { describe, it, expect } from 'vitest'
import { discoverJiraCloud, AtlassianError, resolveAtlassianCreds } from '../atlassian'
import type { ConnectorMap } from '../../../shared/connectors'
import type { OAuthLike } from '../atlassian'

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
