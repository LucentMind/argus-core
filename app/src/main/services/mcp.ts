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
  type ConnectorInstance,
  type ConnectorRuntimeState,
  type DiscoveredTool,
  type HttpConnectorConfig,
  type OAuthStatus,
  type RiskLevel,
  type StdioConnectorConfig
} from '../../shared/connectors'

const PROBE_TIMEOUT_MS = 15000

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
          env: { ...(process.env as Record<string, string>), ...(value as Record<string, string>) }
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
    const headers = value as Record<string, string>
    if (cfg.oauth && this.deps.oauth) {
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
