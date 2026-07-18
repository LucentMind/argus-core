import { describe, it, expect } from 'vitest'
import { probeLangfuseCredentials } from '../langfuseProbe'

const creds = { host: 'https://cloud.langfuse.com', publicKey: 'pk-lf-x', secretKey: 'sk-lf-x' }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('probeLangfuseCredentials', () => {
  it('sends HTTP Basic auth to /api/public/projects', async () => {
    let seenUrl = ''
    let seenAuth = ''
    await probeLangfuseCredentials(creds, async (url, init) => {
      seenUrl = String(url)
      seenAuth = String((init?.headers as Record<string, string>).Authorization)
      return jsonResponse(200, { data: [{ name: 'argus' }] })
    })
    expect(seenUrl).toBe('https://cloud.langfuse.com/api/public/projects')
    expect(seenAuth).toBe(`Basic ${Buffer.from('pk-lf-x:sk-lf-x').toString('base64')}`)
  })

  it('reports the project name on success', async () => {
    const r = await probeLangfuseCredentials(creds, async () =>
      jsonResponse(200, { data: [{ name: 'argus' }] })
    )
    expect(r).toEqual({ ok: true, detail: 'authenticated · project "argus"' })
  })

  it('fails with the API message when credentials are rejected', async () => {
    const r = await probeLangfuseCredentials(creds, async () =>
      jsonResponse(401, {
        message: "Invalid credentials. Confirm that you've configured the correct host."
      })
    )
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('Invalid credentials')
  })

  it('fails without calling the network when no secret key is stored', async () => {
    let called = false
    const r = await probeLangfuseCredentials({ ...creds, secretKey: '' }, async () => {
      called = true
      return jsonResponse(200, {})
    })
    expect(called).toBe(false)
    expect(r).toEqual({ ok: false, detail: 'no secret key stored' })
  })

  it('strips a trailing slash from the host', async () => {
    let seenUrl = ''
    await probeLangfuseCredentials(
      { ...creds, host: 'https://cloud.langfuse.com/' },
      async (url) => {
        seenUrl = String(url)
        return jsonResponse(200, { data: [] })
      }
    )
    expect(seenUrl).toBe('https://cloud.langfuse.com/api/public/projects')
  })

  it('surfaces a network error as a failed check', async () => {
    const r = await probeLangfuseCredentials(creds, async () => {
      throw new Error('getaddrinfo ENOTFOUND cloud.langfuse.com')
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('ENOTFOUND')
  })
})
