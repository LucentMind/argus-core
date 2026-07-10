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
  options: { serverUrl: string | URL; authorizationCode?: string }
) => Promise<'AUTHORIZED' | 'REDIRECT'>

const EXPIRY_SLACK_MS = 60_000
const AUTHORIZE_TIMEOUT_MS = 300_000 // 5 min for the user to approve in the browser

/** One-shot 127.0.0.1 callback server for the system-browser redirect. Exported for tests. */
export async function startLoopback(): Promise<{
  redirectUrl: string
  waitForCode: (timeoutMs: number) => Promise<string>
  close: () => void
}> {
  let resolveCode!: (c: string) => void
  let rejectCode!: (e: Error) => void
  const codeP = new Promise<string>((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>Argus received the authorization. You can close this tab.</body></html>')
    const code = u.searchParams.get('code')
    if (code) resolveCode(code)
    else rejectCode(new Error(u.searchParams.get('error') ?? 'authorization failed'))
  })
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const port = (server.address() as AddressInfo).port
  return {
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    waitForCode: (timeoutMs) =>
      Promise.race([
        codeP,
        new Promise<string>((_, rej) => {
          const t = setTimeout(() => rej(new Error('authorization timed out')), timeoutMs)
          if (typeof t.unref === 'function') t.unref()
        })
      ]),
    close: () => void server.close()
  }
}

/** OAuthClientProvider whose state lives in the SecretStore under mcp/<id>/… names. */
class StoreBackedProvider implements OAuthClientProvider {
  constructor(
    private id: string,
    private secrets: SecretStore,
    private redirect: string,
    private onRedirect: (url: URL) => void | Promise<void>
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
      token_endpoint_auth_method: 'none' // public client + PKCE
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
    private authFn: AuthLike = auth as unknown as AuthLike
  ) {}

  /** Interactive authorization (Authorize / Re-authorize button). */
  async authorize(instanceId: string, serverUrl: string): Promise<{ ok: boolean; error?: string }> {
    const lb = await startLoopback()
    try {
      const provider = new StoreBackedProvider(instanceId, this.secrets, lb.redirectUrl, (url) =>
        this.openExternal(url.toString())
      )
      const first = await this.authFn(provider, { serverUrl })
      if (first !== 'AUTHORIZED') {
        const code = await lb.waitForCode(AUTHORIZE_TIMEOUT_MS)
        const second = await this.authFn(provider, { serverUrl, authorizationCode: code })
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

  /** Non-interactive refresh; a demand for the browser counts as failure → error state. */
  async refresh(instanceId: string, serverUrl: string): Promise<boolean> {
    try {
      // No loopback runs here, so anchor the provider on the STORED client's own
      // redirect so clientInformation()'s stale-port guard self-matches — the
      // refresh_token grant is client-bound and must present the registered
      // client_id, never a fresh dynamic registration.
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
        storedRedirect ?? 'http://127.0.0.1/callback',
        () => {
          throw new Error('interactive authorization required')
        }
      )
      const r = await this.authFn(provider, { serverUrl })
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
}
