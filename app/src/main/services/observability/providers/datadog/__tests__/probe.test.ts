import { describe, it, expect } from 'vitest'
import { probeDatadog } from '../probe'
import { intakeBase, type FetchLike } from '../intake'
import { datadogProvider, DATADOG_API_KEY_SECRET } from '..'

const recorder = (
  res: () => Response | Promise<Response>
): { fetch: FetchLike; calls: Array<{ url: string; init?: RequestInit }> } => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return res()
    }
  }
}

describe('probeDatadog', () => {
  it('ok: GET /api/v1/validate with DD-API-KEY reports the site', async () => {
    const r = recorder(() => new Response('{"valid":true}', { status: 200 }))
    const out = await probeDatadog(
      { base: intakeBase('datadoghq.com'), site: 'datadoghq.com', apiKey: 'KEY' },
      r.fetch
    )
    expect(out).toEqual({ ok: true, detail: 'authenticated · datadoghq.com' })
    expect(r.calls[0].url).toBe('https://api.datadoghq.com/api/v1/validate')
    expect(r.calls[0].init?.headers).toMatchObject({ 'DD-API-KEY': 'KEY' })
    expect(r.calls[0].init?.method).toBeUndefined() // a GET: nothing is written
  })

  it('403 (bad key or wrong site) fails with the status and first error', async () => {
    const r = recorder(() => new Response('{"errors":["Forbidden"]}', { status: 403 }))
    const out = await probeDatadog(
      { base: intakeBase('datadoghq.eu'), site: 'datadoghq.eu', apiKey: 'KEY' },
      r.fetch
    )
    expect(out).toEqual({ ok: false, detail: 'HTTP 403 · Forbidden' })
  })

  it('a 200 that says valid:false fails', async () => {
    const r = recorder(() => new Response('{"valid":false}', { status: 200 }))
    const out = await probeDatadog(
      { base: intakeBase('us3.datadoghq.com'), site: 'us3.datadoghq.com', apiKey: 'KEY' },
      r.fetch
    )
    expect(out).toEqual({ ok: false, detail: 'API key not valid for us3.datadoghq.com' })
  })

  it('a network error fails with its message', async () => {
    const out = await probeDatadog(
      { base: 'https://api.datadoghq.com', site: 'datadoghq.com', apiKey: 'KEY' },
      async () => {
        throw new Error('getaddrinfo ENOTFOUND api.datadoghq.com')
      }
    )
    expect(out).toEqual({ ok: false, detail: 'getaddrinfo ENOTFOUND api.datadoghq.com' })
  })

  it('no key: fails without a request', async () => {
    const r = recorder(() => new Response('{}'))
    const out = await probeDatadog(
      { base: 'https://api.datadoghq.com', site: 'datadoghq.com', apiKey: '' },
      r.fetch
    )
    expect(out).toEqual({ ok: false, detail: 'no API key stored' })
    expect(r.calls).toHaveLength(0)
  })

  it.each([
    ['datadoghq.com', 'https://api.datadoghq.com/api/v1/validate'],
    ['us3.datadoghq.com', 'https://api.us3.datadoghq.com/api/v1/validate'],
    ['us5.datadoghq.com', 'https://api.us5.datadoghq.com/api/v1/validate'],
    ['datadoghq.eu', 'https://api.datadoghq.eu/api/v1/validate'],
    ['ap1.datadoghq.com', 'https://api.ap1.datadoghq.com/api/v1/validate'],
    ['ap2.datadoghq.com', 'https://api.ap2.datadoghq.com/api/v1/validate']
  ])('per-site URL: %s', async (site, url) => {
    const r = recorder(() => new Response('{"valid":true}'))
    await probeDatadog({ base: intakeBase(site), site, apiKey: 'K' }, r.fetch)
    expect(r.calls[0].url).toBe(url)
  })

  it('the provider probe honours a policy intakeUrl and falls back on an unknown site', async () => {
    const realFetch = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(url)
      return new Response('{"valid":true}')
    }) as typeof fetch
    try {
      const secret = (n: string): string | null => (n === DATADOG_API_KEY_SECRET ? 'K' : null)
      await datadogProvider.probe({ site: 'datadoghq.eu', intakeUrl: 'http://relay:8/' }, secret)
      const out = await datadogProvider.probe({ site: 'bogus.example' }, secret)
      expect(out.detail).toBe('authenticated · datadoghq.com')
    } finally {
      globalThis.fetch = realFetch
    }
    expect(urls).toEqual([
      'http://relay:8/api/v1/validate',
      'https://api.datadoghq.com/api/v1/validate'
    ])
  })
})
