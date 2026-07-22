// Jira Cloud REST client — UI-native flows only (New Case / Refresh / Health).
// The agent never calls this; its Jira access is the Rovo MCP connector.
import fs from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  connectorConfig,
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

export type AtlassianProduct = 'jira' | 'confluence'

export interface AtlassianCloud {
  cloudId: string
  siteUrl: string
}

const GATEWAY = 'https://api.atlassian.com'

const SCOPE_MAP: Record<AtlassianProduct, string> = {
  jira: 'jira-work',
  confluence: 'confluence'
}

const PRODUCT_DISPLAY: Record<AtlassianProduct, string> = {
  jira: 'Jira',
  confluence: 'Confluence'
}

export async function discoverCloud(
  bearer: string,
  product: AtlassianProduct,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<AtlassianCloud> {
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
      `Atlassian authorization couldn't reach ${PRODUCT_DISPLAY[product]} (HTTP ${res.status}) — re-authorize the connector in Settings → Connectors.`
    )
  let resources: Array<{ id: string; url: string; scopes?: string[] }>
  try {
    resources = (await res.json()) as Array<{ id: string; url: string; scopes?: string[] }>
  } catch {
    throw new AtlassianError('http', 'Atlassian returned invalid JSON', undefined)
  }
  const scope = SCOPE_MAP[product]
  const cloud = resources.find((r) => (r.scopes ?? []).some((s) => s.includes(scope)))
  if (!cloud)
    throw new AtlassianError(
      'auth',
      `Your Atlassian authorization does not grant ${PRODUCT_DISPLAY[product]} access — re-authorize the connector in Settings → Connectors.`
    )
  return { cloudId: cloud.id, siteUrl: cloud.url.replace(/\/+$/, '') }
}

/** Minimal OAuth surface resolveAtlassianCreds needs (McpOAuth satisfies it). */
export interface OAuthLike {
  status(instanceId: string): 'authorized' | 'not-authorized' | 'error'
  accessToken(instanceId: string): string | null
  refresh(instanceId: string, serverUrl: string): Promise<boolean>
}

export interface AtlassianAuth {
  instanceId: string
  /** Present iff the rovo connector's OAuth is authorized. */
  oauth?: {
    serverUrl: string // config.url, for refresh
    accessToken: () => string | null
    refresh: () => Promise<void>
  }
}

/** Find the rovo-preset connector and resolve its OAuth-only credentials. */
export function resolveAtlassianCreds(connectors: ConnectorMap, oauth: OAuthLike): AtlassianAuth {
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
  const auth: AtlassianAuth = { instanceId }
  if (oauth.status(instanceId) === 'authorized') {
    const cfg = connectorConfig<HttpConnectorConfig>('http', inst.config)
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
 * Instance id of the rovo-preset connector, or null if none is configured.
 * Mirrors the same find as resolveAtlassianCreds — callers use it to look up
 * siteUrl via AtlassianClient.resolveSiteUrl/cachedSiteUrl instead of reading
 * a config field directly.
 */
export function rovoInstanceId(connectors: ConnectorMap): string | null {
  const entry = Object.entries(connectors).find(([, inst]) => inst.preset === 'rovo')
  return entry ? entry[0] : null
}

/**
 * True once Jira REST is usable on a rovo-preset connector: its OAuth is
 * authorized (or 'error', e.g. a failed refresh — still counts as configured so
 * the Health row turns red instead of vanishing). Gates the Health page's
 * Atlassian REST row: a Rovo connector with OAuth never begun is fully healthy
 * without REST, so that state is not a failure — it simply has no row.
 */
export function atlassianRestConfigured(connectors: ConnectorMap, oauth: OAuthLike): boolean {
  return Object.entries(connectors).some(([id, inst]) => {
    if (inst.preset !== 'rovo') return false
    const s = oauth.status(id)
    return s === 'authorized' || s === 'error'
  })
}

export interface JiraIssueData {
  preview: JiraIssuePreview
  descriptionMarkdown: string
  raw: unknown
}

const REST_TIMEOUT_MS = 15000

const DOWNLOAD_IDLE_MS = 60000 // default 60s of no progress → abort

/** AbortController whose deadline re-arms on every bump(); fires only after
 *  idleMs elapses with no progress. clear() stops the timer. */
function idleAbort(idleMs: number): { signal: AbortSignal; bump: () => void; clear: () => void } {
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    timer = setTimeout(() => ctrl.abort(new Error(`no data for ${idleMs}ms`)), idleMs)
  }
  const bump = (): void => {
    if (timer) clearTimeout(timer)
    arm()
  }
  const clear = (): void => {
    if (timer) clearTimeout(timer)
  }
  arm()
  return { signal: ctrl.signal, bump, clear }
}

const ISSUE_FIELDS =
  'summary,description,status,priority,labels,reporter,created,updated,attachment'

export class AtlassianClient {
  private cloudId = new Map<string, AtlassianCloud>()

  constructor(
    private creds: () => AtlassianAuth,
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = REST_TIMEOUT_MS,
    private downloadIdleMs = DOWNLOAD_IDLE_MS
  ) {}

  /** Maps a non-OK gateway response to the right AtlassianError code. */
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
    instanceId: string,
    opts?: { signal?: AbortSignal; accept?: string }
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        headers: { Authorization: authorization, Accept: opts?.accept ?? 'application/json' },
        redirect: 'follow', // undici drops Authorization on cross-origin redirects (attachment CDN)
        signal: opts?.signal ?? AbortSignal.timeout(this.timeoutMs)
      })
    } catch (err) {
      throw new AtlassianError(
        'network',
        `Atlassian request failed: ${(err as Error).message}`,
        instanceId
      )
    }
  }

  /**
   * OAuth-only for both products: path prefix decides the product (`/wiki/` →
   * Confluence, else Jira), which decides the gateway prefix
   * (`/ex/{product}/{cloudId}`) and the discovery scope. No legacy siteUrl/token
   * fallback — Task 4 removes those fields from AtlassianAuth entirely.
   */
  private async request(
    pathAndQuery: string,
    opts?: { signal?: AbortSignal; accept?: string }
  ): Promise<Response> {
    const auth = this.creds()
    const product: AtlassianProduct = pathAndQuery.startsWith('/wiki/') ? 'confluence' : 'jira'
    if (!auth.oauth)
      throw new AtlassianError(
        'auth',
        'Authorize the Atlassian connector in Settings → Connectors.',
        auth.instanceId
      )
    let token = auth.oauth.accessToken()
    if (!token) {
      await auth.oauth.refresh()
      token = auth.oauth.accessToken()
    }
    if (!token)
      throw new AtlassianError(
        'auth',
        'Authorize the Atlassian connector in Settings → Connectors.',
        auth.instanceId
      )
    const cloud = await this.resolveCloud(auth.instanceId, token, product)
    const url = `${GATEWAY}/ex/${product}/${cloud.cloudId}${pathAndQuery}`
    let res = await this.fetchWith(url, `Bearer ${token}`, auth.instanceId, opts)
    if (res.status === 401 || res.status === 403) {
      await auth.oauth.refresh()
      token = auth.oauth.accessToken()
      if (token) res = await this.fetchWith(url, `Bearer ${token}`, auth.instanceId, opts)
      if (!token || res.status === 401 || res.status === 403)
        throw new AtlassianError(
          'auth',
          `Atlassian rejected the connector's authorization (HTTP ${res.status}) — re-authorize in Settings → Connectors.`,
          auth.instanceId
        )
    }
    this.mapStatus(res, auth.instanceId, "the connector's authorization")
    return res
  }

  private async resolveCloud(
    instanceId: string,
    token: string,
    product: AtlassianProduct
  ): Promise<AtlassianCloud> {
    const cached = this.cloudId.get(instanceId)
    if (cached) return cached
    const cloud = await discoverCloud(token, product, this.fetchImpl, this.timeoutMs)
    this.cloudId.set(instanceId, cloud)
    return cloud
  }

  /**
   * Cached siteUrl for an instance, discovering (and caching cloudId+siteUrl)
   * if not already cached. Never throws — returns null when not
   * OAuth-authorized or when discovery fails, since browse-link callers (Task 5)
   * degrade gracefully without a site URL. Discovers with product 'jira' since
   * the cache is shared across products (one cloudId/siteUrl per instance).
   */
  async resolveSiteUrl(instanceId: string): Promise<string | null> {
    const cached = this.cloudId.get(instanceId)
    if (cached) return cached.siteUrl
    try {
      const auth = this.creds()
      if (!auth.oauth) return null
      const token = auth.oauth.accessToken()
      if (!token) return null
      return (await this.resolveCloud(instanceId, token, 'jira')).siteUrl
    } catch {
      return null
    }
  }

  /**
   * Sync read of the cached siteUrl — null if discovery hasn't warmed the
   * cache for this instance yet. Never discovers. For callers that need a
   * synchronous siteUrl after a prior request already warmed the cache (e.g.
   * jiraCases's `site` dependency, read only after getIssue succeeds).
   */
  cachedSiteUrl(instanceId: string): string | null {
    return this.cloudId.get(instanceId)?.siteUrl ?? null
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
      priority: (f.priority as { name?: string } | undefined)?.name ?? null,
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

  /** Streams attachment bytes to destPath (follows Jira's redirect to the media
   *  host). Uses an idle timeout — aborts only after downloadIdleMs of no
   *  progress — so large but healthy downloads are not cut off. */
  async downloadAttachment(id: string, destPath: string): Promise<void> {
    const instanceId = this.creds().instanceId
    const { signal, bump, clear } = idleAbort(this.downloadIdleMs)
    try {
      const res = await this.request(`/rest/api/3/attachment/content/${encodeURIComponent(id)}`, {
        signal,
        accept: '*/*'
      })
      if (!res.body)
        throw new AtlassianError('network', 'Attachment response had no body', instanceId)
      const tick = new Transform({
        transform(chunk, _enc, cb) {
          bump()
          cb(null, chunk)
        }
      })
      await pipeline(Readable.fromWeb(res.body as never), tick, fs.createWriteStream(destPath))
    } catch (err) {
      try {
        fs.rmSync(destPath, { force: true }) // never leave a partial file behind
      } catch {
        /* best-effort: never let cleanup mask the original download error */
      }
      if (err instanceof AtlassianError) throw err
      throw new AtlassianError(
        'network',
        `Attachment download failed: ${(err as Error).message}`,
        instanceId
      )
    } finally {
      clear()
    }
  }

  /** Cheap reachability probe for the Health page — covered by read:jira-work. */
  async probeJira(): Promise<{ reachable: true }> {
    await this.request('/rest/api/3/project/search?maxResults=1')
    return { reachable: true }
  }

  // — Confluence v2 (over the same OAuth gateway/request() as Jira) —

  async getConfluenceSpace(key: string): Promise<ConfluenceSpace> {
    const res = await this.request(`/wiki/api/v2/spaces?keys=${encodeURIComponent(key)}`)
    const body = await this.parseJson<{
      results?: Array<{ id: unknown; key?: string; name?: string; homepageId?: unknown }>
    }>(res)
    const s = body.results?.[0]
    if (!s)
      throw new AtlassianError(
        'not-found',
        `Confluence space ${key} not found`,
        this.creds().instanceId
      )
    return {
      key: s.key ?? key,
      name: s.name ?? s.key ?? key,
      homepageId: String(s.homepageId ?? '')
    }
  }

  async getConfluencePage(pageId: string): Promise<ConfluencePageNode> {
    const res = await this.request(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`)
    return confluenceNodeV2(await this.parseJson<RawV2Page>(res))
  }

  /**
   * v2 children listing carries only `id`/`title` (no version/lastModified/leaf
   * indicator — see .superpowers/sdd/v2-shapes.md), so each child is resolved to
   * a full node via getConfluencePage — an N+1 fetch. Reference-sync runs as an
   * occasional manual operation, so correctness (real version/lastModified) wins
   * over the extra round trips.
   */
  private async childNode(child: RawV2Child): Promise<ConfluencePageNode> {
    return this.getConfluencePage(String(child.id))
  }

  async getConfluenceChildren(pageId: string): Promise<ConfluencePageNode[]> {
    const out: ConfluencePageNode[] = []
    let path: string | null = `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/children?limit=250`
    while (path) {
      const res = await this.request(path)
      const body = await this.parseJson<{ results?: RawV2Child[]; _links?: { next?: string } }>(res)
      for (const child of body.results ?? []) out.push(await this.childNode(child))
      path = nextCursorPath(body._links?.next)
    }
    return out
  }

  async getConfluencePageContent(pageId: string): Promise<ConfluencePageContent> {
    const res = await this.request(
      `/wiki/api/v2/pages/${encodeURIComponent(pageId)}?body-format=atlas_doc_format`
    )
    const c = await this.parseJson<
      RawV2Page & {
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
    // v1 parity: v2 pages still carry _links.base (the "{siteUrl}/wiki" prefix) —
    // NOT resolveSiteUrl, which is unrelated (Jira siteUrl, no /wiki suffix).
    return {
      node: confluenceNodeV2(c),
      url: `${c._links?.base ?? ''}${c._links?.webui ?? ''}`,
      markdown: adfToMarkdown(doc)
    }
  }
}

interface RawV2Page {
  id: unknown
  title?: string
  version?: { number?: number; createdAt?: string }
}
interface RawV2Child {
  id: unknown
  title?: string
}

function confluenceNodeV2(c: RawV2Page): ConfluencePageNode {
  return {
    id: String(c.id),
    title: c.title ?? '',
    version: c.version?.number ?? 0,
    lastModified: c.version?.createdAt ?? null,
    // v2 exposes no leaf indicator on the page object — always descend; an
    // empty children fetch is the natural leaf signal (walkSelection unaffected).
    hasChildren: true
  }
}

/** `_links.next` is already a ready-to-request `/wiki/api/v2/...` path; null when absent (stop). */
function nextCursorPath(next: string | undefined): string | null {
  return next ?? null
}

/** Browse URL for a Jira issue. siteUrl comes from resolveSiteUrl/cachedSiteUrl (already trailing-slash-trimmed). */
export function jiraBrowseUrl(siteUrl: string, key: string): string {
  return `${siteUrl}/browse/${encodeURIComponent(key)}`
}
