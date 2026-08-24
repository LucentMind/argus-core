import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { SecretStore } from './secrets'
import type { OAuthStatus } from '../../shared/connectors'

/** Injected so tests never hit the network; production passes the SDK's auth(). */
export type AuthLike = (
  provider: OAuthClientProvider,
  options: {
    serverUrl: string | URL
    authorizationCode?: string
    /** Space-separated scope override; matches the SDK's own `auth()` option. */
    scope?: string
    /** Custom fetch, e.g. `slackTokenFetch()` for a static-credential connector. */
    fetchFn?: typeof fetch
  }
) => Promise<'AUTHORIZED' | 'REDIRECT'>

/** A pre-registered OAuth client, as configured on a connector instance. */
export interface ConfidentialClient {
  clientId: string
  /** Resolved plaintext, or null when unset / unresolvable. */
  clientSecret: string | null
  /** Space-separated; empty means "let the SDK decide". */
  scopes: string
  /** Empty means ephemeral loopback. */
  redirectUrl: string
}

/** Injected so `oauth.ts` never imports the connector registry (and stays Electron-free). */
export type ClientConfigResolver = (instanceId: string) => ConfidentialClient | null

export interface AuthorizeResult {
  ok: boolean
  error?: string
  /** The configured redirect is not loopback — the caller must collect the code and
   *  call authorizeWithCode() (Task 6). */
  needsCode?: boolean
}

const EXPIRY_SLACK_MS = 60_000
const AUTHORIZE_TIMEOUT_MS = 300_000 // 5 min for the user to approve in the browser

/**
 * True when Argus can listen for the authorization code itself: an empty value (ephemeral
 * loopback, the Rovo default) or an http loopback address. Anything else — including an https
 * localhost URL — means the code comes back by hand.
 */
export function isLoopbackRedirect(url: string): boolean {
  if (!url) return true
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:') return false
  const h = u.hostname.replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

/**
 * Slack answers a FAILED token exchange with HTTP 200 and {"ok":false,"error":"…"}. The MCP
 * SDK only treats non-2xx as an error, so without this the user gets a Zod complaint about a
 * missing access_token instead of "bad_client_secret". Re-emit those as 400s carrying the
 * OAuth error shape. Successful payloads pass through byte-for-byte — Slack's success body
 * already parses against OAuthTokensSchema.
 */
export function slackTokenFetch(inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init)
    if (!res.ok) return res
    // A 204/205 has no body to inspect, and `new Response(text, { status: 204 })` below would
    // throw `TypeError: Response with null body status cannot have body` even with text === ''
    // — the Fetch spec forbids a body on these statuses outright. Nothing downstream needs to
    // examine an empty success body, so hand the original response back untouched.
    if (res.status === 204 || res.status === 205) return res
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) return res
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      // the body was consumed by text(); hand back an equivalent response. Only
      // content-type carries over — content-length/content-encoding described the
      // original transport bytes, not this re-serialized text, and would mislead a
      // downstream consumer (e.g. a stale content-encoding: gzip on plain text).
      return new Response(text, { status: res.status, headers: { 'content-type': contentType } })
    }
    const b = body as { ok?: boolean; error?: string }
    if (b && b.ok === false) {
      const error = b.error ?? 'slack_error'
      return new Response(JSON.stringify({ error, error_description: error }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      })
    }
    // the body was consumed by text(); hand back an equivalent response (see above)
    return new Response(text, { status: res.status, headers: { 'content-type': contentType } })
  }
}

/**
 * One-shot callback server for the system-browser redirect. With no argument it binds an
 * ephemeral port on 127.0.0.1 (the original behavior). With a loopback URL it binds that
 * URL's host, port and path, and reports the URL **verbatim** — Slack matches redirect_uri
 * exactly, so "localhost" must not be normalized to "127.0.0.1". Exported for tests.
 */
export async function startLoopback(publicUrl = ''): Promise<{
  redirectUrl: string
  waitForCode: (timeoutMs: number) => Promise<string>
  close: () => void
}> {
  const target = publicUrl ? new URL(publicUrl) : null
  const wantPath = target?.pathname ?? '/callback'
  const rawHost = (target?.hostname ?? '127.0.0.1').replace(/^\[|\]$/g, '')

  // The reported redirectUrl is the caller's string verbatim (see below), so if it names
  // no port there is no way to report back wherever the OS actually put the ephemeral
  // listener — the two would silently disagree and break the round-trip. The no-argument
  // call is exempt: port 0 there is the point, and nothing is echoed back.
  if (target && (!target.port || Number(target.port) === 0)) {
    throw new Error(
      'redirect URL must specify a port — set one in Redirect URL on the connector card'
    )
  }
  const port = target ? Number(target.port) : 0

  let resolveCode!: (c: string) => void
  let rejectCode!: (e: Error) => void
  const codeP = new Promise<string>((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })
  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname !== wantPath) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>Argus received the authorization. You can close this tab.</body></html>')
    const code = u.searchParams.get('code')
    if (code) resolveCode(code)
    else rejectCode(new Error(u.searchParams.get('error') ?? 'authorization failed'))
  }

  const servers: http.Server[] = []
  const listenOn = (host: string, primary: boolean): Promise<void> =>
    new Promise<void>((res, rej) => {
      const server = http.createServer(handleRequest)
      // A fixed port can be occupied by anything; say which port and which field fixes it,
      // rather than surfacing a bare EADDRINUSE at the connector card. A failure on the
      // SECONDARY (::1) bind is not fatal — see the dual-bind comment below — so it just
      // degrades to the primary listener alone instead of rejecting.
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (!primary) {
          res()
          return
        }
        rej(
          e.code === 'EADDRINUSE'
            ? new Error(
                `redirect port ${port} is already in use — change Redirect URL on the connector card`
              )
            : e
        )
      })
      server.listen(port, host, () => {
        servers.push(server)
        res()
      })
    })

  await listenOn(rawHost === 'localhost' ? '127.0.0.1' : rawHost, true)
  const bound = (servers[0].address() as AddressInfo).port

  if (rawHost === 'localhost') {
    // RFC 8252 §7.3: a native OAuth client "SHOULD listen on both 127.0.0.1 and ::1".
    // Node resolves "localhost" via dns.lookup at listen() time and may bind only one
    // family, but the system browser resolves "localhost" independently and may connect
    // to the other — landing on a port with nothing listening. Bind both so whichever
    // family the browser picks still reaches a listener; both use the same fixed port
    // (guaranteed above), and both resolve the one shared codeP.
    await listenOn('::1', false)
  }

  return {
    redirectUrl: publicUrl || `http://127.0.0.1:${bound}/callback`,
    waitForCode: (timeoutMs) =>
      Promise.race([
        codeP,
        new Promise<string>((_, rej) => {
          const t = setTimeout(() => rej(new Error('authorization timed out')), timeoutMs)
          if (typeof t.unref === 'function') t.unref()
        })
      ]),
    close: () => {
      for (const server of servers) server.close()
    }
  }
}

/** OAuthClientProvider whose state lives in the SecretStore under mcp/<id>/… names. */
class StoreBackedProvider implements OAuthClientProvider {
  constructor(
    private id: string,
    private secrets: SecretStore,
    private redirect: string,
    private onRedirect: (url: URL) => void | Promise<void>,
    /** When set, registration is skipped entirely and these credentials are presented. */
    private staticClient?: { clientId: string; clientSecret: string | null; scope: string }
  ) {}

  get redirectUrl(): string {
    return this.redirect
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Argus',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.staticClient?.clientSecret ? 'client_secret_post' : 'none',
      ...(this.staticClient?.scope ? { scope: this.staticClient.scope } : {})
    }
  }

  private read<T>(name: string): T | undefined {
    const raw = this.secrets.resolve(`mcp/${this.id}/${name}`)
    if (raw == null) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    // A configured client is pinned by config, not by an ephemeral port, so the
    // stale-redirect discard below cannot apply to it. Returning a value here is what
    // makes the SDK skip registerClient() — the whole point for servers without DCR.
    if (this.staticClient?.clientId) {
      return {
        client_id: this.staticClient.clientId,
        ...(this.staticClient.clientSecret
          ? { client_secret: this.staticClient.clientSecret }
          : {}),
        redirect_uris: [this.redirect],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: this.staticClient.clientSecret ? 'client_secret_post' : 'none'
      } as OAuthClientInformationFull
    }
    const info = this.read<OAuthClientInformationFull>('client')
    // a dynamically-registered client's redirect_uris embeds the loopback port
    // from the run that registered it; a later run picks a different ephemeral
    // port, and strict servers reject the mismatched redirect_uri. Discard the
    // stale registration so the SDK re-registers against the current redirect.
    // (optional-chained: a hand-corrupted blob without redirect_uris must not throw)
    if (info && !info.redirect_uris?.includes(this.redirect)) return undefined
    return info
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    if (this.staticClient?.clientId) return // nothing was registered; nothing to persist
    this.secrets.set(`mcp/${this.id}/client`, JSON.stringify(info))
  }

  tokens(): OAuthTokens | undefined {
    return this.read('tokens')
  }

  saveTokens(tokens: OAuthTokens): void {
    this.secrets.set(`mcp/${this.id}/tokens`, JSON.stringify({ ...tokens, obtainedAt: Date.now() }))
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    return this.onRedirect(authorizationUrl)
  }

  saveCodeVerifier(verifier: string): void {
    this.secrets.set(`mcp/${this.id}/verifier`, verifier)
  }

  codeVerifier(): string {
    const v = this.secrets.resolve(`mcp/${this.id}/verifier`)
    if (!v) throw new Error('no code verifier stored')
    return v
  }
}

/**
 * Runs the MCP SDK OAuth handshake in main: system browser + loopback
 * redirect; tokens custodied in the keychain-backed SecretStore (spec §2.4).
 */
export class McpOAuth {
  private errors = new Map<string, string>()

  constructor(
    private secrets: SecretStore,
    private openExternal: (url: string) => Promise<void>,
    private authFn: AuthLike = auth as unknown as AuthLike,
    private clientConfig: ClientConfigResolver = () => null
  ) {}

  /**
   * The `{ clientId, clientSecret, scope }` shape StoreBackedProvider's static-client branch
   * needs — built identically at all three call sites (authorize/authorizeWithCode/refresh),
   * which is exactly the kind of security-relevant duplication that drifts. `undefined` means
   * "no configured client — take the public-client/DCR path" (Rovo).
   */
  private static stat(
    cfg: ConfidentialClient | null
  ): { clientId: string; clientSecret: string | null; scope: string } | undefined {
    return cfg?.clientId
      ? { clientId: cfg.clientId, clientSecret: cfg.clientSecret, scope: cfg.scopes }
      : undefined
  }

  /**
   * A confidential-client server (one with a configured redirectUrl, e.g. Slack) has no
   * registration_endpoint. With no clientId yet entered, the SDK's only remaining path is
   * dynamic client registration, which fails as "Incompatible auth server: does not support
   * dynamic client registration" — a confusing error for what is really just an unfilled
   * field, and the default first-click experience on a freshly-added Slack preset. Generic on
   * "redirectUrl configured, no clientId" rather than `preset === 'slack'`, so it covers any
   * future confidential-client server the same way. Rovo configures neither redirectUrl nor
   * clientId and legitimately relies on DCR, so this never fires for it.
   *
   * Known cost, accepted rather than fixed: this condition also matches a legitimate DCR-capable
   * server whose user pinned a fixed loopback port (startLoopback supports that — see the
   * publicUrl param) instead of using the ephemeral default. That connector would get Authorize
   * disabled with this Slack-flavored message. Reachability is low — CONNECTOR_FORMS.http does
   * not expose redirectUrl, so it requires hand-editing mcp-servers.json — so this is not
   * re-scoped to `preset === 'slack'`.
   */
  private static missingClientId(cfg: ConfidentialClient | null): string | null {
    // .trim() on the test only: a space-only Client ID (e.g. pasted with trailing whitespace,
    // or a stray key press) must not slip past this guard and fail opaquely at Slack instead.
    // The value itself is never trimmed here — only whether it counts as "configured".
    return cfg?.redirectUrl && !cfg.clientId?.trim()
      ? 'no Client ID configured — add it from your Slack app on the connector card before authorizing'
      : null
  }

  /** Interactive authorization (Authorize / Re-authorize button). */
  async authorize(instanceId: string, serverUrl: string): Promise<AuthorizeResult> {
    const cfg = this.clientConfig(instanceId)
    const missing = McpOAuth.missingClientId(cfg)
    if (missing) {
      // Named before binding any port — a fixed configured redirect otherwise reserves the
      // port for nothing, and the by-hand path would open a browser tab with no way to
      // exchange the code.
      this.errors.set(instanceId, missing)
      return { ok: false, error: missing }
    }
    const redirect = cfg?.redirectUrl ?? ''
    const scope = cfg?.scopes || undefined
    const stat = McpOAuth.stat(cfg)
    // Only a static-credential connector needs Slack's 200-with-ok:false quirk translated
    // into a real HTTP error — the DCR/Rovo path must see the plain global fetch.
    const fetchFn = stat ? slackTokenFetch() : undefined

    if (!isLoopbackRedirect(redirect)) {
      return this.authorizeByHand(instanceId, serverUrl, redirect, scope, stat, fetchFn)
    }

    let lb: Awaited<ReturnType<typeof startLoopback>>
    try {
      // Inside its own try: a fixed configured port may be occupied, or the redirect may
      // be malformed in a way startLoopback rejects — either must reach the connector card
      // as a named error result, never an unhandled rejection. Nothing has touched the
      // stored grant yet, so a bind failure here leaves an existing working connector alone.
      lb = await startLoopback(redirect)
    } catch (err) {
      const message = (err as Error).message
      this.errors.set(instanceId, message)
      return { ok: false, error: message }
    }
    try {
      // Drop any stored grant now that the loopback listener is up and authFn is about to
      // run. The SDK's auth() refreshes whenever the provider yields a refresh_token and
      // re-throws a non-ServerError OAuthError (invalid_grant) rather than falling through
      // to startAuthorization — so presenting a revoked/expired refresh_token here fails
      // before the browser ever opens, leaving the connector stuck with no way back. This
      // path is interactive by definition: a fresh grant is the whole point. Any client
      // registration is deliberately kept — it stays valid, and clientInformation()'s
      // stale-redirect guard handles the rest.
      this.secrets.delete(`mcp/${instanceId}/tokens`)

      const provider = new StoreBackedProvider(
        instanceId,
        this.secrets,
        lb.redirectUrl,
        (url) => this.openExternal(url.toString()),
        stat
      )
      const first = await this.authFn(provider, { serverUrl, scope, fetchFn })
      if (first !== 'AUTHORIZED') {
        const code = await lb.waitForCode(AUTHORIZE_TIMEOUT_MS)
        const second = await this.authFn(provider, {
          serverUrl,
          authorizationCode: code,
          scope,
          fetchFn
        })
        if (second !== 'AUTHORIZED') throw new Error('authorization did not complete')
      }
      this.errors.delete(instanceId)
      return { ok: true }
    } catch (err) {
      const message = (err as Error).message
      this.errors.set(instanceId, message)
      return { ok: false, error: message }
    } finally {
      lb.close()
    }
  }

  /**
   * Non-loopback redirect: Argus cannot listen on the user's https URL, so it opens the
   * consent page and stops — no listener is ever started on this path. The caller collects
   * the `?code=` value and calls authorizeWithCode(). The PKCE verifier is already in the
   * secret store, so the two halves join up across separate calls.
   */
  private async authorizeByHand(
    instanceId: string,
    serverUrl: string,
    redirect: string,
    scope: string | undefined,
    stat: { clientId: string; clientSecret: string | null; scope: string } | undefined,
    fetchFn: typeof fetch | undefined
  ): Promise<AuthorizeResult> {
    try {
      const provider = new StoreBackedProvider(
        instanceId,
        this.secrets,
        redirect,
        (url) => this.openExternal(url.toString()),
        stat
      )
      // Same discipline as the loopback path (Task 5), and for the same reason: a
      // stale/revoked refresh_token would make the SDK's own auth() throw during its
      // internal refresh attempt, before ever reaching startAuthorization — stranding
      // the connector with the browser never opened. Positioned immediately before
      // authFn so a failure at this delete itself — SecretStore.delete() persists to
      // disk (unguarded fs.mkdirSync/writeFileSync/renameSync in fileStore.ts) and can
      // throw — is caught by the same try/catch below and leaves an existing working
      // grant alone, rather than proceeding to authFn on a half-cleared store.
      //
      // This deletion is also load-bearing for refresh()'s no-refresh-token short-circuit
      // staying safe during the paste window that follows: once authFn below reaches
      // startAuthorization, the provider's saveCodeVerifier() leaves a PKCE verifier in the
      // store for however long the user takes to copy the code out of the browser and call
      // authorizeWithCode(). If a refresh_token had ALSO still been present at that moment, a
      // concurrent refresh() (composeHeaders' refreshOnExpiry, or Test connection) would skip
      // its short-circuit, reach the SDK's own auth(), and call saveCodeVerifier() again —
      // clobbering the verifier this in-flight authorization needs at exchange time. Deleting
      // the stored tokens (and their refresh_token) here first is what makes
      // storedRefreshToken() in refresh() find nothing and short-circuit instead. Remove this
      // delete and that clobber comes back.
      this.secrets.delete(`mcp/${instanceId}/tokens`)
      const r = await this.authFn(provider, { serverUrl, scope, fetchFn })
      // Clear a stale error from a prior failed attempt whether this run finishes
      // (AUTHORIZED) or merely reaches the browser (needsCode) — needsCode is not a
      // failure and status() must not keep reporting the old one.
      this.errors.delete(instanceId)
      if (r === 'AUTHORIZED') {
        return { ok: true }
      }
      // not an error: the browser is open and the user owes us a code
      return { ok: false, needsCode: true }
    } catch (err) {
      const message = (err as Error).message
      this.errors.set(instanceId, message)
      return { ok: false, error: message }
    }
  }

  /**
   * Second half of the non-loopback flow: exchange a hand-carried authorization code.
   * Presents the SAME redirect_uri authorizeByHand used (both read it from clientConfig),
   * since Slack matches redirect_uri exactly at both the authorize and token steps.
   */
  async authorizeWithCode(
    instanceId: string,
    serverUrl: string,
    code: string
  ): Promise<AuthorizeResult> {
    const cfg = this.clientConfig(instanceId)
    const missing = McpOAuth.missingClientId(cfg)
    if (missing) {
      // Same guard as authorize() — reachable if the Client ID field is cleared between the
      // authorize() call that opened the browser (needsCode) and the paste-back here.
      this.errors.set(instanceId, missing)
      return { ok: false, error: missing }
    }
    const stat = McpOAuth.stat(cfg)
    try {
      const provider = new StoreBackedProvider(
        instanceId,
        this.secrets,
        cfg?.redirectUrl ?? '',
        () => {
          // the exchange must never need the browser again; if it does, the grant is wrong
          throw new Error('interactive authorization required')
        },
        stat
      )
      const r = await this.authFn(provider, {
        serverUrl,
        authorizationCode: code.trim(),
        scope: cfg?.scopes || undefined,
        fetchFn: stat ? slackTokenFetch() : undefined
      })
      if (r !== 'AUTHORIZED') throw new Error('authorization did not complete')
      this.errors.delete(instanceId)
      return { ok: true }
    } catch (err) {
      const message = (err as Error).message
      this.errors.set(instanceId, message)
      return { ok: false, error: message }
    }
  }

  /** Non-interactive refresh; a demand for the browser counts as failure → error state. */
  async refresh(instanceId: string, serverUrl: string): Promise<boolean> {
    try {
      // A refresh can only ever succeed by presenting a stored refresh_token — without one,
      // calling authFn only reaches the SDK's own auth(), which falls through to
      // startAuthorization. For a static (confidential) client, startAuthorization calls
      // provider.saveCodeVerifier() BEFORE our throwing redirectToAuthorization() ever runs —
      // clobbering whatever PKCE verifier authorizeByHand's paste flow is mid-way through,
      // possibly for minutes while the user copies a code out of the browser address bar.
      // composeHeaders(..., { refreshOnExpiry: true }) (mcp.ts) calls refresh() on every
      // unauthorized connector — reachable from a new session, Test connection, and the
      // Health page — so short-circuit here, before touching the provider at all, and go
      // through the same catch below so status() still reports 'error' exactly as it does
      // for any other refresh failure. Strictly correct (a refresh could never have
      // succeeded without one) and also skips a pointless discovery round-trip.
      if (!this.storedRefreshToken(instanceId)) throw new Error('no refresh token stored')

      const cfg = this.clientConfig(instanceId)
      const stat = McpOAuth.stat(cfg)
      // No loopback runs here, so anchor the provider on the STORED client's own
      // redirect so clientInformation()'s stale-port guard self-matches — the
      // refresh_token grant is client-bound and must present the registered
      // client_id, never a fresh dynamic registration. A configured client pins its
      // own redirect, so it takes priority over whatever got stored.
      let storedRedirect: string | undefined
      const rawClient = this.secrets.resolve(`mcp/${instanceId}/client`)
      if (rawClient != null) {
        try {
          storedRedirect = (JSON.parse(rawClient) as OAuthClientInformationFull).redirect_uris?.[0]
        } catch {
          /* corrupt blob — fall through to the placeholder */
        }
      }
      const provider = new StoreBackedProvider(
        instanceId,
        this.secrets,
        cfg?.redirectUrl || storedRedirect || 'http://127.0.0.1/callback',
        () => {
          throw new Error('interactive authorization required')
        },
        stat
      )
      const r = await this.authFn(provider, {
        serverUrl,
        scope: cfg?.scopes || undefined,
        fetchFn: stat ? slackTokenFetch() : undefined
      })
      if (r !== 'AUTHORIZED') throw new Error('interactive authorization required')
      this.errors.delete(instanceId)
      return true
    } catch (err) {
      this.errors.set(instanceId, (err as Error).message)
      return false
    }
  }

  /** Sync read for compose/probe; null when absent or within 60 s of expiry. */
  accessToken(instanceId: string): string | null {
    const raw = this.secrets.resolve(`mcp/${instanceId}/tokens`)
    if (raw == null) return null
    try {
      const t = JSON.parse(raw) as OAuthTokens & { obtainedAt?: number }
      if (t.expires_in != null && t.obtainedAt != null) {
        if (t.obtainedAt + t.expires_in * 1000 - EXPIRY_SLACK_MS < Date.now()) return null
      }
      return t.access_token ?? null
    } catch {
      return null
    }
  }

  status(instanceId: string): OAuthStatus {
    if (this.errors.has(instanceId)) return 'error'
    return this.secrets.has(`mcp/${instanceId}/tokens`) ? 'authorized' : 'not-authorized'
  }

  clear(instanceId: string): void {
    for (const n of ['tokens', 'client', 'verifier']) this.secrets.delete(`mcp/${instanceId}/${n}`)
    this.errors.delete(instanceId)
  }

  /** The refresh_token from the stored grant, or undefined when absent/corrupt/never set. */
  private storedRefreshToken(instanceId: string): string | undefined {
    const raw = this.secrets.resolve(`mcp/${instanceId}/tokens`)
    if (raw == null) return undefined
    try {
      return (JSON.parse(raw) as OAuthTokens).refresh_token
    } catch {
      return undefined
    }
  }
}
