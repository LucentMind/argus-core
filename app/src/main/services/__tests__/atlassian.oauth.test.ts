import { describe, it, expect } from 'vitest'
import { discoverJiraCloud, AtlassianError } from '../atlassian'

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
})
