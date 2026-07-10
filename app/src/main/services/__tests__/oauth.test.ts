import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { McpOAuth, startLoopback, type AuthLike } from '../oauth'
import { SecretStore, type SecretCrypto } from '../secrets'

const fakeCrypto = (): SecretCrypto => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').slice(4)
})

let tmp: string, secrets: SecretStore

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-oauth-'))
  secrets = new SecretStore(path.join(tmp, 'home'), fakeCrypto())
})

afterEach(() => {
  secrets.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('startLoopback', () => {
  it('serves /callback, resolves the code, answers with closable HTML', async () => {
    const lb = await startLoopback()
    try {
      expect(lb.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      const codeP = lb.waitForCode(5000)
      const res = await fetch(`${lb.redirectUrl}?code=abc123&state=xyz`)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('close')
      expect(await codeP).toBe('abc123')
    } finally {
      lb.close()
    }
  })

  it('rejects on an error redirect', async () => {
    const lb = await startLoopback()
    try {
      const codeP = lb.waitForCode(5000)
      await fetch(`${lb.redirectUrl}?error=access_denied`)
      await expect(codeP).rejects.toThrow(/access_denied/)
    } finally {
      lb.close()
    }
  })
})

describe('McpOAuth', () => {
  const SERVER = 'https://mcp.atlassian.com/v1/sse'

  it('authorize: opens the browser, finishes with the callback code, stores tokens', async () => {
    const opened: string[] = []
    // fake auth(): first call demands a redirect (and simulates the browser
    // hitting the loopback); second call (with authorizationCode) saves tokens.
    const authFn: AuthLike = async (provider, opts) => {
      if (opts.authorizationCode) {
        await provider.saveTokens({
          access_token: 'tok-1',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'ref-1'
        })
        return 'AUTHORIZED'
      }
      await provider.redirectToAuthorization(new URL('https://auth.atlassian.com/authorize?x=1'))
      setTimeout(() => void fetch(`${provider.redirectUrl}?code=the-code`), 50)
      return 'REDIRECT'
    }
    const oauth = new McpOAuth(secrets, async (u) => void opened.push(u), authFn)
    const r = await oauth.authorize('rovo', SERVER)
    expect(r.ok).toBe(true)
    expect(opened[0]).toContain('auth.atlassian.com')
    expect(oauth.status('rovo')).toBe('authorized')
    expect(oauth.accessToken('rovo')).toBe('tok-1')
    expect(secrets.has('mcp/rovo/tokens')).toBe(true)
  })

  it('accessToken: null when absent; null when expired', () => {
    const oauth = new McpOAuth(secrets, async () => {}, vi.fn() as unknown as AuthLike)
    expect(oauth.accessToken('rovo')).toBeNull()
    secrets.set(
      'mcp/rovo/tokens',
      JSON.stringify({
        access_token: 'old',
        token_type: 'bearer',
        expires_in: 1,
        obtainedAt: Date.now() - 10_000
      })
    )
    expect(oauth.accessToken('rovo')).toBeNull()
    secrets.set(
      'mcp/rovo/tokens',
      JSON.stringify({
        access_token: 'fresh',
        token_type: 'bearer',
        expires_in: 3600,
        obtainedAt: Date.now()
      })
    )
    expect(oauth.accessToken('rovo')).toBe('fresh')
  })

  it('refresh: non-interactive success clears error; interactive demand or throw → status error', async () => {
    const good: AuthLike = async (provider) => {
      await provider.saveTokens({ access_token: 'tok-2', token_type: 'bearer', expires_in: 3600 })
      return 'AUTHORIZED'
    }
    const oauth = new McpOAuth(secrets, async () => {}, good)
    expect(await oauth.refresh('rovo', SERVER)).toBe(true)
    expect(oauth.status('rovo')).toBe('authorized')

    const needsBrowser: AuthLike = async (provider) => {
      await provider.redirectToAuthorization(new URL('https://auth.example.com'))
      return 'REDIRECT'
    }
    const oauth2 = new McpOAuth(secrets, async () => {}, needsBrowser)
    expect(await oauth2.refresh('rovo2', SERVER)).toBe(false)
    expect(oauth2.status('rovo2')).toBe('error')
  })

  it('clear removes tokens/client/verifier and resets status', async () => {
    secrets.set('mcp/rovo/tokens', JSON.stringify({ access_token: 't', token_type: 'bearer' }))
    secrets.set('mcp/rovo/client', '{}')
    secrets.set('mcp/rovo/verifier', 'v')
    const oauth = new McpOAuth(secrets, async () => {}, vi.fn() as unknown as AuthLike)
    expect(oauth.status('rovo')).toBe('authorized')
    oauth.clear('rovo')
    expect(oauth.status('rovo')).toBe('not-authorized')
    expect(secrets.has('mcp/rovo/tokens')).toBe(false)
    expect(secrets.has('mcp/rovo/client')).toBe(false)
  })
})
