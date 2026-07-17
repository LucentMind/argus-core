import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { ConnectorRegistry } from './connectors'
import type { SecretStore } from './secrets'
import {
  classifyToolName,
  connectorConfig,
  resolveSecretRefs,
  RESERVED_INSTANCE_IDS,
  type ComposedMcp,
  type ConnectorInstance,
  type ConnectorRuntimeState,
  type DiscoveredTool,
  type HttpConnectorConfig,
  type OAuthStatus,
  type RiskLevel,
  type StdioConnectorConfig
} from '../../shared/connectors'

const PROBE_TIMEOUT_MS = 15000

/**
 * Hand-edited mcp-servers.json can carry non-string env/header values (a bare
 * number, a boolean); resolveSecretRefs passes them through untouched, and the
 * SDK transports throw deep inside on non-strings — coerce at this boundary.
 */
function toStringRecord(v: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries((v ?? {}) as Record<string, unknown>).map(([k, val]) => [k, String(val)])
  )
}

/** Deterministic JSON: object keys sorted at every depth, so an identical config always
 *  hashes identically regardless of insertion order. */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, canonicalize(val)])
    )
  }
  return v
}

/**
 * Stable hash of a composed mcpServers map. A change means a live session's frozen
 * map is stale and the session must be rebuilt (spec §2).
 *
 * The bearer token is hashed deliberately (spec §3.1). Redacting it would avoid a
 * rebuild per token rotation, but MCP's SSE transport re-sends headers on every POST,
 * so a frozen session would keep POSTing a dead token and 401 mid-conversation —
 * reintroducing the exact stale-credential class this spec removes. Lives in main,
 * not shared/: node:crypto must never reach the renderer's typecheck:web.
 */
export function fingerprintServers(servers: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(servers)))
    .digest('hex')
}

/** Filled by McpOAuth (Task 7); optional so Tasks 5–6 test without OAuth. */
export interface McpOAuthLike {
  accessToken(instanceId: string): string | null
  refresh(instanceId: string, serverUrl: string): Promise<boolean>
  status(instanceId: string): OAuthStatus
}

export interface McpServiceDeps {
  registry: ConnectorRegistry
  secrets: SecretStore
  toolRisk: () => Record<string, RiskLevel>
  oauth?: McpOAuthLike
  /** Per-step probe budget (connect / listTools each); tests inject a small value. */
  probeTimeoutMs?: number
}

/**
 * Two roles, one service (spec §2.3):
 * 1. Health client — short-lived @modelcontextprotocol/sdk connections for
 *    Test connection / discovery / Health rows; never the agent's transport.
 * 2. Session config composer (Task 6) — enabled, non-error connectors into
 *    the Agent SDK mcpServers map, secrets resolved at compose time.
 */
export class McpService {
  private runtime = new Map<string, ConnectorRuntimeState>()

  constructor(private deps: McpServiceDeps) {}

  runtimeStates(): Record<string, ConnectorRuntimeState> {
    const out: Record<string, ConnectorRuntimeState> = {}
    for (const id of Object.keys(this.deps.registry.get()))
      out[id] = this.runtime.get(id) ?? { state: 'never-connected' }
    return out
  }

  /** Mark a connector failed outside a probe (e.g. OAuth refresh failure). */
  markError(instanceId: string, reason: string): void {
    this.runtime.set(instanceId, { state: 'error', reason })
  }

  /**
   * Drop a connector's runtime state (back to never-connected). Called after a
   * successful authorize so the connector card stops showing a stale needs-auth
   * badge. Display-only: compose does not consult runtime state.
   */
  clearRuntime(instanceId: string): void {
    this.runtime.delete(instanceId)
  }

  /**
   * Build the Agent SDK mcpServers additions for a session (spec §1).
   *
   * NOT side-effect-free: composeHeaders(..., { refreshOnExpiry: true }) can perform a
   * network OAuth token refresh and persist the rotated tokens to disk. The property
   * that actually matters here is narrower: this method must never read or write
   * `this.runtime` — that Map is display-only, owned by probe()/markError. A verdict
   * cached there would outlive the condition that set it, which is exactly the bug this
   * shape exists to prevent. Async so it can reuse composeHeaders' OAuth refresh: an
   * expired token heals here instead of latching.
   */
  async composeForSession(): Promise<ComposedMcp> {
    const servers: Record<string, unknown> = {}
    const skipped: ComposedMcp['skipped'] = []
    for (const [id, inst] of Object.entries(this.deps.registry.get())) {
      if ((RESERVED_INSTANCE_IDS as readonly string[]).includes(id)) {
        skipped.push({ instanceId: id, reason: 'reserved instance id' })
        continue
      }
      if (!inst.enabled) continue // disabled by the user: silent
      try {
        if (inst.kind === 'stdio') {
          const cfg = connectorConfig<StdioConnectorConfig>('stdio', inst.config)
          const { value, missing } = resolveSecretRefs(cfg.env, (n) => this.deps.secrets.resolve(n))
          if (missing.length) throw new Error(`missing secrets: ${missing.join(', ')}`)
          servers[id] = {
            type: 'stdio',
            command: cfg.command,
            args: cfg.args,
            env: toStringRecord(value)
          }
        } else if (inst.kind === 'http') {
          const cfg = connectorConfig<HttpConnectorConfig>('http', inst.config)
          const headers = await this.composeHeaders(id, cfg, { refreshOnExpiry: true })
          servers[id] =
            cfg.transport === 'sse'
              ? { type: 'sse', url: cfg.url, headers }
              : { type: 'http', url: cfg.url, headers }
        } else {
          throw new Error(`unsupported kind: ${inst.kind}`)
        }
      } catch (err) {
        skipped.push({ instanceId: id, reason: (err as Error).message })
      }
    }
    return { servers, skipped, fingerprint: fingerprintServers(servers) }
  }

  /** Test connection: connect → listTools → classify → cache → tear down. */
  async probe(
    instanceId: string
  ): Promise<{ ok: boolean; tools?: DiscoveredTool[]; error?: string }> {
    const inst = this.deps.registry.get()[instanceId]
    if (!inst) return { ok: false, error: `unknown connector: ${instanceId}` }
    // Constructed here (not inside connect()) so the finally can always tear it
    // down — even when connect() loses the timeout race with a transport already
    // attached and a stdio child already spawned.
    const client = new Client({ name: 'argus-health', version: '1.0.0' })
    try {
      await this.withTimeout(this.connect(client, instanceId, inst), 'connect')
      const listed = await this.withTimeout(client.listTools(), 'listTools')
      const overrides = this.deps.toolRisk()
      const tools: DiscoveredTool[] = listed.tools.map((t) => ({
        name: t.name,
        description: t.description,
        risk: overrides[`${instanceId}/${t.name}`] ?? classifyToolName(t.name)
      }))
      this.deps.registry.setDiscovered(instanceId, tools)
      this.runtime.set(instanceId, {
        state: 'connected',
        at: new Date().toISOString(),
        toolCount: tools.length
      })
      return { ok: true, tools }
    } catch (err) {
      const message = (err as Error).message
      // SDK transport errors (StreamableHTTPError / SseError) carry the HTTP
      // status as a structured .code; the message regex is only a fallback.
      const code = (err as { code?: unknown }).code
      this.runtime.set(
        instanceId,
        code === 401 || /401|unauthorized/i.test(message)
          ? { state: 'needs-auth' }
          : { state: 'error', reason: message }
      )
      return { ok: false, error: message }
    } finally {
      // spec §2.3: probe processes/connections are torn down after the probe
      await client.close().catch(() => {})
    }
  }

  private withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
    const timeoutMs = this.deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${what} timed out after ${timeoutMs}ms`)), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
  }

  private async connect(
    client: Client,
    instanceId: string,
    inst: ConnectorInstance
  ): Promise<void> {
    if (inst.kind === 'stdio') {
      const cfg = connectorConfig<StdioConnectorConfig>('stdio', inst.config)
      const { value, missing } = resolveSecretRefs(cfg.env, (n) => this.deps.secrets.resolve(n))
      if (missing.length) throw new Error(`missing secrets: ${missing.join(', ')}`)
      await client.connect(
        new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: { ...(process.env as Record<string, string>), ...toStringRecord(value) }
        })
      )
      return
    }
    if (inst.kind === 'http') {
      const cfg = connectorConfig<HttpConnectorConfig>('http', inst.config)
      const headers = await this.composeHeaders(instanceId, cfg, { refreshOnExpiry: true })
      const url = new URL(cfg.url)
      if (cfg.transport === 'sse')
        await client.connect(new SSEClientTransport(url, { requestInit: { headers } }))
      else
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }))
      return
    }
    throw new Error(`unsupported kind: ${inst.kind}`)
  }

  /** Resolve header $secret refs; inject the OAuth bearer for oauth connectors (Task 7 fills deps.oauth). */
  private async composeHeaders(
    instanceId: string,
    cfg: HttpConnectorConfig,
    opts: { refreshOnExpiry: boolean }
  ): Promise<Record<string, string>> {
    const { value, missing } = resolveSecretRefs(cfg.headers, (n) => this.deps.secrets.resolve(n))
    if (missing.length) throw new Error(`missing secrets: ${missing.join(', ')}`)
    const headers = toStringRecord(value)
    if (cfg.oauth) {
      // Guard, not a silent skip: the pre-refactor inline compose threw when the oauth
      // dep was absent. Without this, an oauth connector would compose with NO
      // Authorization header and fail opaquely at the transport instead.
      if (!this.deps.oauth) throw new Error('oauth connector but no oauth provider configured')
      let token = this.deps.oauth.accessToken(instanceId)
      if (token == null && opts.refreshOnExpiry) {
        await this.deps.oauth.refresh(instanceId, cfg.url)
        token = this.deps.oauth.accessToken(instanceId)
      }
      if (token == null)
        throw new Error('unauthorized: no valid OAuth token — use Authorize on the connector card')
      headers.Authorization = `Bearer ${token}`
    }
    return headers
  }
}
