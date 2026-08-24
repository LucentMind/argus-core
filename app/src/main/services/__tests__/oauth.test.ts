import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  McpOAuth,
  startLoopback,
  isLoopbackRedirect,
  slackTokenFetch,
  type AuthLike,
  type ConfidentialClient
} from '../oauth'
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata
} from '@modelcontextprotocol/sdk/shared/auth.js'
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
      // Attach the rejection handler BEFORE the fetch that triggers it —
      // otherwise codeP rejects during the fetch await with no handler yet
      // attached, and Node/Vitest flags a (transiently) unhandled rejection.
      const assertion = expect(codeP).rejects.toThrow(/access_denied/)
      await fetch(`${lb.redirectUrl}?error=access_denied`)
      await assertion
    } finally {
      lb.close()
    }
  })

  // Discover a port the OS just handed out and immediately released. Racy in principle,
  // standard in practice — and far better than hardcoding a port CI might be using.
  const freePort = async (): Promise<number> => {
    const probe = await startLoopback()
    const port = Number(new URL(probe.redirectUrl).port)
    probe.close()
    return port
  }

  it('binds the port and path from a supplied redirect URL, and reports it verbatim', async () => {
    const port = await freePort()
    // Reported verbatim, NOT rebuilt as 127.0.0.1 — Slack matches redirect_uri exactly,
    // so the "localhost" spelling has to survive all the way to the token exchange.
    const url = `http://localhost:${port}/slack-cb`
    const lb = await startLoopback(url)
    try {
      expect(lb.redirectUrl).toBe(url)
      const codeP = lb.waitForCode(5000)
      // and the server really is listening on that host/port/path
      await fetch(`${url}?code=from-slack`)
      expect(await codeP).toBe('from-slack')
    } finally {
      lb.close()
    }
  })

  it('names the port and the field to change when the port is taken', async () => {
    const first = await startLoopback()
    const port = Number(new URL(first.redirectUrl).port)
    try {
      await expect(startLoopback(`http://127.0.0.1:${port}/callback`)).rejects.toThrow(
        new RegExp(`${port}.*already in use`)
      )
    } finally {
      first.close()
    }
  })

  it('binds a "localhost" redirect URL on 127.0.0.1, reachable there', async () => {
    const port = await freePort()
    const lb = await startLoopback(`http://localhost:${port}/callback`)
    try {
      const codeP = lb.waitForCode(5000)
      await fetch(`http://127.0.0.1:${port}/callback?code=via-v4`)
      expect(await codeP).toBe('via-v4')
    } finally {
      lb.close()
    }
  })

  it('binds a "localhost" redirect URL on ::1 too, since the browser may resolve there instead', async () => {
    const port = await freePort()
    const lb = await startLoopback(`http://localhost:${port}/callback`)
    try {
      const codeP = lb.waitForCode(5000)
      await fetch(`http://[::1]:${port}/callback?code=via-v6`)
      expect(await codeP).toBe('via-v6')
    } finally {
      lb.close()
    }
  })

  it('close() releases both loopback listeners bound for a "localhost" URL', async () => {
    const port = await freePort()
    const lb = await startLoopback(`http://localhost:${port}/callback`)
    lb.close()
    // If either listener survived close(), one of these same-port binds would
    // throw EADDRINUSE instead of succeeding.
    const v4 = await startLoopback(`http://127.0.0.1:${port}/callback`)
    v4.close()
    const v6 = await startLoopback(`http://[::1]:${port}/callback`)
    v6.close()
  })

  it('rejects a portless redirect URL — the ephemeral port picked would not match what is reported', async () => {
    await expect(startLoopback('http://localhost/callback')).rejects.toThrow(
      /must specify a port.*Redirect URL/
    )
  })

  it('rejects an explicit :0 redirect URL for the same reason', async () => {
    await expect(startLoopback('http://localhost:0/callback')).rejects.toThrow(
      /must specify a port.*Redirect URL/
    )
  })
})

describe('isLoopbackRedirect', () => {
  it('treats empty, localhost, 127.0.0.1 and ::1 over http as loopback', () => {
    expect(isLoopbackRedirect('')).toBe(true)
    expect(isLoopbackRedirect('http://localhost:8080/callback')).toBe(true)
    expect(isLoopbackRedirect('http://127.0.0.1:8080/callback')).toBe(true)
    expect(isLoopbackRedirect('http://[::1]:8080/callback')).toBe(true)
  })

  it('rejects anything else — those need the paste-the-code path', () => {
    expect(isLoopbackRedirect('https://example.com/oauth/callback')).toBe(false)
    expect(isLoopbackRedirect('https://localhost:8080/callback')).toBe(false) // https ⇒ not ours
    expect(isLoopbackRedirect('not a url')).toBe(false)
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

  it('authorize: a stale/revoked refresh_token still reaches the browser', async () => {
    // The SDK's auth() refreshes first whenever the provider yields a
    // refresh_token, and re-throws a non-ServerError OAuthError (invalid_grant)
    // instead of falling through to startAuthorization. Interactive authorize
    // must therefore not present the stale grant at all, or the browser never
    // opens and the connector is stuck unrecoverably.
    secrets.set(
      'mcp/rovo/tokens',
      JSON.stringify({
        access_token: 'dead',
        token_type: 'bearer',
        refresh_token: 'revoked-by-the-server',
        obtainedAt: Date.now()
      })
    )
    const opened: string[] = []
    const authFn: AuthLike = async (provider, opts) => {
      if (opts.authorizationCode) {
        await provider.saveTokens({
          access_token: 'tok-fresh',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'ref-fresh'
        })
        return 'AUTHORIZED'
      }
      if ((await provider.tokens())?.refresh_token) throw new Error('refresh_token is invalid') // what Atlassian returns
      await provider.redirectToAuthorization(new URL('https://auth.atlassian.com/authorize?x=1'))
      setTimeout(() => void fetch(`${provider.redirectUrl}?code=the-code`), 50)
      return 'REDIRECT'
    }
    const oauth = new McpOAuth(secrets, async (u) => void opened.push(u), authFn)
    const r = await oauth.authorize('rovo', SERVER)
    expect(r.ok).toBe(true)
    expect(opened[0]).toContain('auth.atlassian.com')
    expect(oauth.status('rovo')).toBe('authorized')
    expect(oauth.accessToken('rovo')).toBe('tok-fresh')
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

  it('clientInformation: stale redirect_uris (old loopback port) → undefined, forcing re-registration', async () => {
    secrets.set(
      'mcp/x/client',
      JSON.stringify({
        client_id: 'c1',
        redirect_uris: ['http://127.0.0.1:1111/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      })
    )
    let captured: unknown
    const authFn: AuthLike = async (provider) => {
      captured = provider.clientInformation()
      await provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 })
      return 'AUTHORIZED'
    }
    const oauth = new McpOAuth(secrets, async () => {}, authFn)
    const r = await oauth.authorize('x', SERVER)
    expect(r.ok).toBe(true)
    // the loopback picks a fresh ephemeral port each run, which never matches
    // the stored 1111 — the stale client info must be discarded
    expect(captured).toBeUndefined()
  })

  it('clientInformation: matching redirect_uris → the stored client info is returned', async () => {
    let capturedRedirect = ''
    let captured: unknown
    const authFn: AuthLike = async (provider) => {
      capturedRedirect = String(provider.redirectUrl)
      // seed AFTER the loopback picked its port, using that exact redirect url
      secrets.set(
        'mcp/y/client',
        JSON.stringify({
          client_id: 'c2',
          redirect_uris: [capturedRedirect],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        })
      )
      captured = provider.clientInformation()
      await provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 })
      return 'AUTHORIZED'
    }
    const oauth = new McpOAuth(secrets, async () => {}, authFn)
    const r = await oauth.authorize('y', SERVER)
    expect(r.ok).toBe(true)
    expect((captured as { client_id: string })?.client_id).toBe('c2')
  })

  it('refresh: presents the STORED client registration (guard self-matches via stored redirect_uris)', async () => {
    secrets.set(
      'mcp/x/client',
      JSON.stringify({
        client_id: 'c-keep',
        redirect_uris: ['http://127.0.0.1:2222/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      })
    )
    let captured: unknown
    const authFn: AuthLike = async (provider) => {
      captured = provider.clientInformation()
      await provider.saveTokens({ access_token: 'tok-r', token_type: 'bearer', expires_in: 3600 })
      return 'AUTHORIZED'
    }
    const oauth = new McpOAuth(secrets, async () => {}, authFn)
    expect(await oauth.refresh('x', SERVER)).toBe(true)
    // refresh tokens are client-bound — the provider must present the stored
    // registration, never discard it and re-register under a placeholder redirect
    expect((captured as { client_id: string })?.client_id).toBe('c-keep')
  })

  it('refresh: a corrupted client blob without redirect_uris does not throw', async () => {
    secrets.set('mcp/x/client', JSON.stringify({ client_id: 'c-broken' }))
    const authFn: AuthLike = async (provider) => {
      provider.clientInformation() // must not throw despite missing redirect_uris
      await provider.saveTokens({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 })
      return 'AUTHORIZED'
    }
    const oauth = new McpOAuth(secrets, async () => {}, authFn)
    expect(await oauth.refresh('x', SERVER)).toBe(true)
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

describe('confidential client', () => {
  const SERVER = 'https://mcp.slack.com/mcp'
  // authorize() now actually binds the configured redirectUrl (it used to ignore it and
  // always bind ephemeral), so the fixture needs a real, currently-free port rather than
  // the old "port 0 as a don't-care placeholder" — startLoopback rejects an explicit :0
  // on a supplied URL (Task 2). Discovered per test, not hardcoded, same as freePort()
  // in the startLoopback suite above.
  let port = 0
  beforeEach(async () => {
    const probe = await startLoopback()
    port = Number(new URL(probe.redirectUrl).port)
    probe.close()
  })
  const slackCfg = (over: Partial<ConfidentialClient> = {}): ConfidentialClient => ({
    clientId: '123.456',
    clientSecret: 'sh-secret',
    scopes: 'channels:history users:read',
    redirectUrl: `http://localhost:${port}/callback`,
    ...over
  })

  it('presents configured credentials so the SDK never attempts registration', async () => {
    let info: OAuthClientInformationFull | undefined
    let meta: OAuthClientMetadata | undefined
    const authFn: AuthLike = async (provider, opts) => {
      if (opts.authorizationCode) {
        info = (await provider.clientInformation()) as OAuthClientInformationFull
        meta = provider.clientMetadata
        // A real SDK may still call saveClientInformation() even when clientInformation()
        // already returned a value (it's the same code path DCR would use to persist a
        // fresh registration). The guard must no-op here rather than persist this — if
        // the early return in saveClientInformation() were removed, this call alone would
        // make the assertion below false.
        await provider.saveClientInformation?.({
          client_id: '999.999',
          client_secret: 'should-not-be-written',
          redirect_uris: [String(provider.redirectUrl)],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_post'
        } as OAuthClientInformationFull)
        await provider.saveTokens({ access_token: 'xoxp-1', token_type: 'user' })
        return 'AUTHORIZED'
      }
      await provider.redirectToAuthorization(new URL('https://slack.com/oauth/v2_user/authorize'))
      setTimeout(() => void fetch(`${provider.redirectUrl}?code=c1`), 50)
      return 'REDIRECT'
    }
    const oauth = new McpOAuth(
      secrets,
      async () => {},
      authFn,
      () => slackCfg()
    )
    const r = await oauth.authorize('slack', SERVER)
    expect(r.ok).toBe(true)
    expect(info?.client_id).toBe('123.456')
    expect(info?.client_secret).toBe('sh-secret')
    expect(meta?.token_endpoint_auth_method).toBe('client_secret_post')
    // saveClientInformation() was called above with a registered-client payload;
    // the static-client guard must have discarded it rather than persisting it
    expect(secrets.has('mcp/slack/client')).toBe(false)
  })

  it('carries the configured scopes into client metadata', async () => {
    let meta: OAuthClientMetadata | undefined
    const authFn: AuthLike = async (provider) => {
      meta = provider.clientMetadata
      await provider.saveTokens({ access_token: 'xoxp-2', token_type: 'user' })
      return 'AUTHORIZED'
    }
    const oauth = new McpOAuth(
      secrets,
      async () => {},
      authFn,
      () => slackCfg()
    )
    await oauth.authorize('slack', SERVER)
    expect(meta?.scope).toBe('channels:history users:read')
  })

  it('an empty clientId falls back to the public-client DCR path (Rovo is unaffected)', async () => {
    let info: unknown = 'unset'
    const authFn: AuthLike = async (provider) => {
      info = await provider.clientInformation()
      await provider.saveTokens({ access_token: 'tok', token_type: 'bearer' })
      return 'AUTHORIZED'
    }
    const oauth = new McpOAuth(
      secrets,
      async () => {},
      authFn,
      () => slackCfg({ clientId: '', clientSecret: null })
    )
    await oauth.authorize('rovo', SERVER)
    expect(info).toBeUndefined()
    expect(oauth.status('rovo')).toBe('authorized')
  })

  it('clientInformation: the static-client branch wins over a stale stored registration (branch order)', async () => {
    // Seed a leftover dynamic registration whose redirect_uris names an old ephemeral
    // loopback port — never the one this run's fresh loopback will pick. If the
    // stale-redirect discard in clientInformation() ran BEFORE the static-client check,
    // this stored client's mismatched redirect_uris would make it return undefined
    // instead of ever reaching the static branch.
    secrets.set(
      'mcp/slack/client',
      JSON.stringify({
        client_id: 'stale-dcr-client',
        redirect_uris: ['http://127.0.0.1:1111/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      })
    )
    let info: OAuthClientInformationFull | undefined
    const authFn: AuthLike = async (provider) => {
      info = (await provider.clientInformation()) as OAuthClientInformationFull
      await provider.saveTokens({ access_token: 'xoxp-3', token_type: 'user' })
      return 'AUTHORIZED'
    }
    const oauth = new McpOAuth(
      secrets,
      async () => {},
      authFn,
      () => slackCfg()
    )
    const r = await oauth.authorize('slack', SERVER)
    expect(r.ok).toBe(true)
    // must be the STATIC client, not undefined from the stale-redirect discard
    expect(info?.client_id).toBe('123.456')
  })
})

describe('authorize: redirect and scope plumbing', () => {
  const SERVER = 'https://mcp.slack.com/mcp'

  it('binds the configured loopback port and hands the SDK the same redirect_uri', async () => {
    // free port, discovered rather than hardcoded — see freePort() in the startLoopback suite
    const probe = await startLoopback()
    const port = Number(new URL(probe.redirectUrl).port)
    probe.close()
    const redirectUrl = `http://127.0.0.1:${port}/cb`

    let seenRedirect = ''
    let seenScope: string | undefined
    const authFn: AuthLike = async (provider, opts) => {
      if (opts.authorizationCode) {
        await provider.saveTokens({ access_token: 'xoxp-9', token_type: 'user' })
        return 'AUTHORIZED'
      }
      seenRedirect = String(provider.redirectUrl)
      seenScope = opts.scope
      await provider.redirectToAuthorization(new URL('https://slack.com/oauth/v2_user/authorize'))
      setTimeout(() => void fetch(`${redirectUrl}?code=c9`), 50)
      return 'REDIRECT'
    }
    const oauth = new McpOAuth(
      secrets,
      async () => {},
      authFn,
      () => ({
        clientId: '1.2',
        clientSecret: 's',
        scopes: 'channels:history',
        redirectUrl
      })
    )
    const r = await oauth.authorize('slack', SERVER)
    expect(r.ok).toBe(true)
    expect(seenRedirect).toBe(redirectUrl)
    expect(seenScope).toBe('channels:history')
  })

  it('surfaces a bind failure as an error result, not a throw', async () => {
    const busy = await startLoopback()
    const port = Number(new URL(busy.redirectUrl).port)
    try {
      const oauth = new McpOAuth(
        secrets,
        async () => {},
        vi.fn() as unknown as AuthLike,
        () => ({
          clientId: '1.2',
          clientSecret: 's',
          scopes: '',
          redirectUrl: `http://127.0.0.1:${port}/callback`
        })
      )
      const r = await oauth.authorize('slack', SERVER)
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/already in use/)
    } finally {
      busy.close()
    }
  })

  it('refresh presents the configured client, never a fresh registration', async () => {
    let info: OAuthClientInformationFull | undefined
    const authFn: AuthLike = async (provider) => {
      info = (await provider.clientInformation()) as OAuthClientInformationFull
      await provider.saveTokens({ access_token: 'xoxp-r', token_type: 'user' })
      return 'AUTHORIZED'
    }
    const oauth = new McpOAuth(
      secrets,
      async () => {},
      authFn,
      () => ({
        clientId: '7.7',
        clientSecret: 'sec',
        scopes: '',
        redirectUrl: 'http://localhost:8080/callback'
      })
    )
    expect(await oauth.refresh('slack', SERVER)).toBe(true)
    expect(info?.client_id).toBe('7.7')
  })
})

describe('slackTokenFetch', () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })

  it('turns a 200 {"ok":false} into a 400 the SDK will report as an OAuth error', async () => {
    const f = slackTokenFetch(async () => json({ ok: false, error: 'bad_client_secret' }))
    const res = await f('https://slack.com/api/oauth.v2.user.access')
    expect(res.status).toBe(400)
    // The SDK's parseErrorResponse (client/auth.js) builds the user-visible message
    // from error_description, not error: `new errorClass(error_description || '', ...)`.
    // `error` only selects which OAuthError subclass to throw. Asserting just `error`
    // here would stay green even if error_description were dropped from the body,
    // while the user's error message silently went empty — the whole point of this fix.
    expect(await res.json()).toMatchObject({
      error: 'bad_client_secret',
      error_description: 'bad_client_secret'
    })
  })

  it('passes a successful token response through untouched', async () => {
    const body = {
      ok: true,
      access_token: 'xoxp-abc',
      token_type: 'user',
      authed_user: { id: 'U1' }
    }
    const f = slackTokenFetch(async () => json(body))
    const res = await f('https://slack.com/api/oauth.v2.user.access')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(body)
  })

  it('leaves metadata discovery alone — those payloads carry no ok field', async () => {
    const f = slackTokenFetch(async () => json({ issuer: 'https://mcp.slack.com' }))
    const res = await f('https://mcp.slack.com/.well-known/oauth-authorization-server')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ issuer: 'https://mcp.slack.com' })
  })

  it('passes through an already-failing (non-2xx) response untouched', async () => {
    // Non-ok responses return at the very first guard, before the content-type
    // check or any body read — this must never reach the JSON-parsing logic below.
    const f = slackTokenFetch(async () => new Response('nope', { status: 502 }))
    const res = await f('https://slack.com/x')
    expect(res.status).toBe(502)
    expect(await res.text()).toBe('nope')
  })

  it('passes through a 2xx response with a non-JSON content-type untouched', async () => {
    const f = slackTokenFetch(
      async () =>
        new Response('<html>not json</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
    )
    const res = await f('https://slack.com/x')
    expect(res.status).toBe(200)
    // Proves the original body was never consumed — a body-already-read regression
    // would surface here as an empty string, not as a status-code mismatch.
    expect(await res.text()).toBe('<html>not json</html>')
  })

  it('reconstructs a 2xx JSON-typed response whose body is not valid JSON', async () => {
    const f = slackTokenFetch(
      async () =>
        new Response('not actually json', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    const res = await f('https://slack.com/x')
    expect(res.status).toBe(200)
    // The catch-and-reconstruct branch reads the body via text() to attempt JSON.parse,
    // then must hand back an equivalent, still-readable response — not the consumed one.
    expect(await res.text()).toBe('not actually json')
  })
})
