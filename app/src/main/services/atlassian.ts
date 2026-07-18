// Jira Cloud REST client — UI-native flows only (New Case / Refresh / Health).
// The agent never calls this; its Jira access is the Rovo MCP connector.
import fs from 'node:fs'
import {
  connectorConfig,
  isSecretRef,
  type ConnectorMap,
  type HttpConnectorConfig
} from '../../shared/connectors'
import type {
  AtlassianErrorCode,
  JiraAttachmentInfo,
  JiraCommentInfo,
  JiraIssuePreview
} from '../../shared/jira'
import type {
  ConfluenceSpace,
  ConfluencePageNode,
  ConfluencePageContent
} from '../../shared/confluence'
import { adfToMarkdown } from './adf'

export class AtlassianError extends Error {
  constructor(
    public code: AtlassianErrorCode,
    message: string,
    public instanceId?: string
  ) {
    super(message)
    this.name = 'AtlassianError'
  }
}

export interface JiraCloud {
  cloudId: string
  siteUrl: string
}

const GATEWAY = 'https://api.atlassian.com'

export async function discoverJiraCloud(
  bearer: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<JiraCloud> {
  let res: Response
  try {
    res = await fetchImpl(`${GATEWAY}/oauth/token/accessible-resources`, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    throw new AtlassianError('network', `Atlassian request failed: ${(err as Error).message}`)
  }
  if (!res.ok)
    throw new AtlassianError(
      'auth',
      `Atlassian authorization couldn't reach Jira (HTTP ${res.status}) — re-authorize the connector in Settings → Connectors.`
    )
  let resources: Array<{ id: string; url: string; scopes?: string[] }>
  try {
    resources = (await res.json()) as Array<{ id: string; url: string; scopes?: string[] }>
  } catch {
    throw new AtlassianError('http', 'Atlassian returned invalid JSON', undefined)
  }
  const jira = resources.find((r) => (r.scopes ?? []).some((s) => s.includes('jira-work')))
  if (!jira)
    throw new AtlassianError(
      'auth',
      'Your Atlassian authorization does not grant Jira access — re-authorize, or set an API token.'
    )
  return { cloudId: jira.id, siteUrl: jira.url.replace(/\/+$/, '') }
}

/** Minimal OAuth surface resolveAtlassianCreds needs (McpOAuth satisfies it). */
export interface OAuthLike {
  status(instanceId: string): 'authorized' | 'not-authorized' | 'error'
  accessToken(instanceId: string): string | null
  refresh(instanceId: string, serverUrl: string): Promise<boolean>
}

export interface AtlassianAuth {
  instanceId: string
  siteUrl: string | null // legacy base + browse-URL source; null if unset
  token: string | null // legacy REST token; null if unset
  email?: string
  /** Present iff the rovo connector's OAuth is authorized. */
  oauth?: {
    serverUrl: string // config.url, for refresh
    accessToken: () => string | null
    refresh: () => Promise<void>
  }
}

/** @deprecated use AtlassianAuth — kept so existing callers still compile. */
export type AtlassianCreds = AtlassianAuth

/** Find the rovo-preset connector and resolve its mode-aware credentials. */
export function resolveAtlassianCreds(
  connectors: ConnectorMap,
  resolveSecret: (name: string) => string | null,
  oauth: OAuthLike
): AtlassianAuth {
  // `inst.enabled` is deliberately ignored here: this REST path is UI-native (New
  // Case / Refresh) and independent of the agent's MCP session — `enabled` only
  // governs whether the connector is composed into that MCP session.
  const entry = Object.entries(connectors).find(([, inst]) => inst.preset === 'rovo')
  if (!entry)
    throw new AtlassianError(
      'not-configured',
      'No Atlassian connector configured — add the Atlassian Rovo preset in Settings → Connectors.'
    )
  const [instanceId, inst] = entry
  const cfg = connectorConfig<HttpConnectorConfig>('http', inst.config)
  const siteUrl = (cfg.siteUrl ?? '').trim().replace(/\/+$/, '') || null
  const token = isSecretRef(cfg.apiToken) ? resolveSecret(cfg.apiToken.$secret) : null
  const email = (cfg.email ?? '').trim()
  const auth: AtlassianAuth = { instanceId, siteUrl, token, ...(email ? { email } : {}) }
  if (oauth.status(instanceId) === 'authorized') {
    const serverUrl = cfg.url
    auth.oauth = {
      serverUrl,
      accessToken: () => oauth.accessToken(instanceId),
      refresh: async () => {
        await oauth.refresh(instanceId, serverUrl)
      }
    }
  }
  return auth
}

/**
 * Site URL of the rovo-preset connector, or null if none is set. Unlike
 * resolveAtlassianCreds this never requires the API token — browser deep-links
 * (Open in Jira) need no REST auth, the user's browser session covers it.
 */
export function atlassianSiteUrl(connectors: ConnectorMap): string | null {
  const inst = Object.values(connectors).find((i) => i.preset === 'rovo')
  if (!inst) return null
  const cfg = connectorConfig<HttpConnectorConfig>('http', inst.config)
  const siteUrl = (cfg.siteUrl ?? '').trim().replace(/\/+$/, '')
  return /^https?:\/\//.test(siteUrl) ? siteUrl : null
}

/**
 * True once Jira REST is usable on a rovo-preset connector: its OAuth is
 * authorized, or legacy REST configuration has begun (siteUrl or token set).
 * Gates the Health page's Atlassian REST row: a Rovo connector used MCP-only
 * with neither is fully healthy without REST, so that state is not a failure
 * — it simply has no row.
 */
export function atlassianRestConfigured(connectors: ConnectorMap, oauth: OAuthLike): boolean {
  return Object.entries(connectors).some(([id, inst]) => {
    if (inst.preset !== 'rovo') return false
    if (oauth.status(id) === 'authorized') return true
    const cfg = connectorConfig<HttpConnectorConfig>('http', inst.config)
    return Boolean((cfg.siteUrl ?? '').trim()) || isSecretRef(cfg.apiToken)
  })
}

export interface JiraIssueData {
  preview: JiraIssuePreview
  descriptionMarkdown: string
  raw: unknown
}

const REST_TIMEOUT_MS = 15000
const ISSUE_FIELDS = 'summary,description,status,labels,reporter,created,updated,attachment'

export class AtlassianClient {
  private cloudId = new Map<string, JiraCloud>()

  constructor(
    private creds: () => AtlassianAuth,
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = REST_TIMEOUT_MS
  ) {}

  /** Shared status→error mapping so both the OAuth-gateway and legacy paths agree. */
  private mapStatus(res: Response, instanceId: string, authDescription: string): void {
    if (res.status === 401 || res.status === 403)
      throw new AtlassianError(
        'auth',
        `Atlassian rejected ${authDescription} (HTTP ${res.status}).`,
        instanceId
      )
    if (res.status === 404) throw new AtlassianError('not-found', 'Not found on Jira', instanceId)
    if (!res.ok)
      throw new AtlassianError('http', `Atlassian returned HTTP ${res.status}`, instanceId)
  }

  private async fetchWith(
    url: string,
    authorization: string,
    instanceId: string
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        headers: { Authorization: authorization, Accept: 'application/json' },
        redirect: 'follow', // undici drops Authorization on cross-origin redirects (attachment CDN)
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (err) {
      throw new AtlassianError(
        'network',
        `Atlassian request failed: ${(err as Error).message}`,
        instanceId
      )
    }
  }

  /** Legacy REST path: {siteUrl}{pathAndQuery} with Basic (email:token) or Bearer (token only). */
  private async legacyRequest(pathAndQuery: string): Promise<Response> {
    const { instanceId, siteUrl, token, email } = this.creds()
    if (!siteUrl || !token)
      throw new AtlassianError(
        'no-token',
        'Authorize the Atlassian connector (or set an API token) in Settings → Connectors.',
        instanceId
      )
    // Jira Cloud accepts API tokens only via Basic (email:token); Bearer serves Server/DC PATs.
    const authorization = email
      ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
      : `Bearer ${token}`
    const res = await this.fetchWith(`${siteUrl}${pathAndQuery}`, authorization, instanceId)
    this.mapStatus(
      res,
      instanceId,
      'the API token — check the token, email, and Site URL on the connector (Jira Cloud requires the email)'
    )
    return res
  }

  private async request(pathAndQuery: string): Promise<Response> {
    const auth = this.creds()
    // Confluence is always token-only — the gateway's OAuth surface is Jira-only.
    if (pathAndQuery.startsWith('/wiki/')) return this.legacyRequest(pathAndQuery)

    if (auth.oauth) {
      let token = auth.oauth.accessToken()
      if (!token) {
        await auth.oauth.refresh()
        token = auth.oauth.accessToken()
      }
      if (token) {
        let cloud: JiraCloud
        try {
          cloud = await this.resolveCloud(auth.instanceId, token)
        } catch (err) {
          // Cloud discovery failed (bad/expired token, no Jira access, network) —
          // fall back to the legacy token path if one is configured, else rethrow.
          if (auth.token) return this.legacyRequest(pathAndQuery)
          throw err
        }
        const gatewayUrl = `${GATEWAY}/ex/jira/${cloud.cloudId}${pathAndQuery}`
        let res = await this.fetchWith(gatewayUrl, `Bearer ${token}`, auth.instanceId)
        if (res.status === 401 || res.status === 403) {
          await auth.oauth.refresh()
          token = auth.oauth.accessToken()
          if (token) res = await this.fetchWith(gatewayUrl, `Bearer ${token}`, auth.instanceId)
          if (!token || res.status === 401 || res.status === 403) {
            if (auth.token) return this.legacyRequest(pathAndQuery)
            throw new AtlassianError(
              'auth',
              `Atlassian rejected the Rovo connector's authorization (HTTP ${res.status}) — re-authorize the connector in Settings → Connectors.`,
              auth.instanceId
            )
          }
        }
        this.mapStatus(res, auth.instanceId, "the Rovo connector's authorization")
        return res
      }
    }
    return this.legacyRequest(pathAndQuery)
  }

  private async resolveCloud(instanceId: string, token: string): Promise<JiraCloud> {
    const cached = this.cloudId.get(instanceId)
    if (cached) return cached
    const cloud = await discoverJiraCloud(token, this.fetchImpl, this.timeoutMs)
    this.cloudId.set(instanceId, cloud)
    return cloud
  }

  /**
   * Drops the cached cloudId for an instance. Call this whenever its OAuth grant
   * is cleared or re-authorized — otherwise a re-auth to a different Atlassian
   * site keeps resolving Jira calls against the previous site's cloudId.
   */
  invalidateCloud(instanceId: string): void {
    this.cloudId.delete(instanceId)
  }

  private async parseJson<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T
    } catch {
      throw new AtlassianError('http', 'Atlassian returned invalid JSON', this.creds().instanceId)
    }
  }

  async getIssue(key: string): Promise<JiraIssueData> {
    const res = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`
    )
    const raw = await this.parseJson<{ key?: string; fields?: Record<string, unknown> }>(res)
    const f = raw.fields ?? {}
    const attachments: JiraAttachmentInfo[] = (
      (f.attachment as Array<Record<string, unknown>>) ?? []
    ).map((a) => ({
      id: String(a.id ?? ''),
      filename: String(a.filename ?? 'attachment'),
      size: Number(a.size ?? 0),
      mimeType: String(a.mimeType ?? ''),
      createdAt: String(a.created ?? '')
    }))
    const preview: JiraIssuePreview = {
      key: String(raw.key ?? key),
      summary: String(f.summary ?? ''),
      status: String((f.status as { name?: string } | undefined)?.name ?? ''),
      labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
      reporter: (f.reporter as { displayName?: string } | undefined)?.displayName ?? null,
      created: String(f.created ?? ''),
      updated: String(f.updated ?? ''),
      attachments
    }
    return { preview, descriptionMarkdown: adfToMarkdown(f.description), raw }
  }

  /** All comments on an issue, oldest first; paginated so long threads are never truncated. */
  async getComments(key: string): Promise<JiraCommentInfo[]> {
    const out: JiraCommentInfo[] = []
    for (let startAt = 0; ;) {
      const res = await this.request(
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=created&startAt=${startAt}&maxResults=50`
      )
      const body = await this.parseJson<{
        comments?: Array<Record<string, unknown>>
        total?: number
      }>(res)
      const page = body.comments ?? []
      for (const c of page) {
        out.push({
          id: String(c.id ?? ''),
          author: (c.author as { displayName?: string } | undefined)?.displayName ?? null,
          created: String(c.created ?? ''),
          updated: String(c.updated ?? ''),
          bodyMarkdown: adfToMarkdown(c.body)
        })
      }
      startAt += page.length
      if (page.length === 0 || startAt >= Number(body.total ?? 0)) return out
    }
  }

  /** Downloads attachment bytes to destPath (follows Jira's redirect to the media host). */
  async downloadAttachment(id: string, destPath: string): Promise<void> {
    const res = await this.request(`/rest/api/3/attachment/content/${encodeURIComponent(id)}`)
    fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
  }

  /** Cheap reachability probe for the Health page — covered by read:jira-work. */
  async probeJira(): Promise<{ reachable: true }> {
    await this.request('/rest/api/3/project/search?maxResults=1')
    return { reachable: true }
  }

  // — Confluence (Wave 3 Part 3; same request()/auth/error mapping as Jira) —

  async getConfluenceSpace(key: string): Promise<ConfluenceSpace> {
    const res = await this.request(
      `/wiki/rest/api/space/${encodeURIComponent(key)}?expand=homepage`
    )
    const s = await this.parseJson<{ key: string; name?: string; homepage?: { id?: unknown } }>(res)
    return { key: s.key, name: s.name ?? s.key, homepageId: String(s.homepage?.id ?? '') }
  }

  async getConfluencePage(pageId: string): Promise<ConfluencePageNode> {
    const res = await this.request(
      `/wiki/rest/api/content/${encodeURIComponent(pageId)}?expand=${CONFLUENCE_NODE_EXPAND}`
    )
    return confluenceNode(await this.parseJson<RawConfluenceContent>(res))
  }

  async getConfluenceChildren(pageId: string): Promise<ConfluencePageNode[]> {
    const res = await this.request(
      `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/page?limit=200&expand=${CONFLUENCE_NODE_EXPAND}`
    )
    const body = await this.parseJson<{ results?: RawConfluenceContent[] }>(res)
    return (body.results ?? []).map(confluenceNode)
  }

  async getConfluencePageContent(pageId: string): Promise<ConfluencePageContent> {
    const res = await this.request(
      `/wiki/rest/api/content/${encodeURIComponent(pageId)}?expand=body.atlas_doc_format,${CONFLUENCE_NODE_EXPAND}`
    )
    const c = await this.parseJson<
      RawConfluenceContent & {
        body?: { atlas_doc_format?: { value?: string } }
        _links?: { base?: string; webui?: string }
      }
    >(res)
    let doc: unknown = null
    try {
      doc = JSON.parse(c.body?.atlas_doc_format?.value ?? 'null')
    } catch {
      doc = null
    }
    return {
      node: confluenceNode(c),
      url: `${c._links?.base ?? ''}${c._links?.webui ?? ''}`,
      markdown: adfToMarkdown(doc)
    }
  }
}

const CONFLUENCE_NODE_EXPAND = 'version,history.lastUpdated,children.page'

interface RawConfluenceContent {
  id: unknown
  title?: string
  version?: { number?: number }
  history?: { lastUpdated?: { when?: string } }
  children?: { page?: { size?: number } }
}

function confluenceNode(c: RawConfluenceContent): ConfluencePageNode {
  return {
    id: String(c.id),
    title: c.title ?? '',
    version: c.version?.number ?? 0,
    lastModified: c.history?.lastUpdated?.when ?? null,
    hasChildren: (c.children?.page?.size ?? 0) > 0
  }
}

/** Browse URL for a Jira issue. siteUrl comes from AtlassianCreds (already trailing-slash-trimmed). */
export function jiraBrowseUrl(siteUrl: string, key: string): string {
  return `${siteUrl}/browse/${encodeURIComponent(key)}`
}
