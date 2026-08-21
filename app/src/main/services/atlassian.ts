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
  CloneLink,
  JiraAttachmentInfo,
  JiraCommentInfo,
  JiraIssuePreview,
  JiraLinkType
} from '../../shared/jira'
import type {
  ConfluenceSpace,
  ConfluencePageNode,
  ConfluencePageContent
} from '../../shared/confluence'
import { DEFAULT_CLONE_LINK_TYPES } from '../../shared/settings'
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

/** One page of a JQL search. `nextPageToken` is null on the last page. */
export interface JiraSearchPage {
  issues: Array<{ key: string; created: string; updated: string }>
  nextPageToken: string | null
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
  'summary,description,status,priority,labels,reporter,created,updated,attachment,issuelinks'

/**
 * Pure: extract clone relations from an issue's `fields`, keeping links whose type name is in
 * `acceptedTypes` (compared case-insensitively). Malformed entries are skipped.
 *
 * The accepted names are workspace configuration (`settings.jira.cloneLinkTypes`, default
 * ["Cloners"]) because an organisation can rename Jira's built-in clone link type, and a
 * mismatch is silent — discovery simply finds nothing, with no error anywhere.
 */
export function cloneLinksOf(
  fields: Record<string, unknown>,
  acceptedTypes: string[]
): CloneLink[] {
  const accepted = new Set(acceptedTypes.map((t) => t.toLowerCase()))
  const links = fields.issuelinks
  if (!Array.isArray(links)) return []
  const out: CloneLink[] = []
  for (const l of links) {
    if (!l || typeof l !== 'object') continue
    const entry = l as Record<string, unknown>
    const name = (entry.type as { name?: string } | undefined)?.name ?? ''
    if (!accepted.has(name.toLowerCase())) continue
    // inward on a Cloners link reads "is cloned by": the fetched issue is the ORIGINAL.
    const inward = entry.inwardIssue as { key?: string; fields?: { summary?: string } } | undefined
    const outward = entry.outwardIssue as
      { key?: string; fields?: { summary?: string } } | undefined
    const side = inward ?? outward
    if (!side?.key) continue
    out.push({
      key: String(side.key),
      summary: String(side.fields?.summary ?? ''),
      direction: inward ? 'is-cloned-by' : 'clones'
    })
  }
  return out
}

export class AtlassianClient {
  private cloudId = new Map<string, AtlassianCloud>()

  constructor(
    private creds: () => AtlassianAuth,
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = REST_TIMEOUT_MS,
    private downloadIdleMs = DOWNLOAD_IDLE_MS,
    /** Accepted clone link-type names, read per call so a settings change needs no restart —
     *  a snapshot taken at construction would pin the list to whatever was on disk at boot. */
    private cloneLinkTypes: () => string[] = () => [...DEFAULT_CLONE_LINK_TYPES]
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
    opts?: {
      signal?: AbortSignal
      accept?: string
      method?: string
      body?: BodyInit
      headers?: Record<string, string>
    }
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: opts?.method,
        body: opts?.body,
        headers: {
          // Caller headers spread FIRST: Authorization/Accept are set after, so a caller
          // (or a stray header the caller forwards) can never override this request's
          // real auth or content negotiation.
          ...opts?.headers,
          Authorization: authorization,
          Accept: opts?.accept ?? 'application/json'
        },
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
    opts?: {
      signal?: AbortSignal
      accept?: string
      method?: string
      body?: BodyInit
      headers?: Record<string, string>
    }
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
   *
   * Refreshes on a null token exactly like request() does: accessToken() also
   * reports null inside its 60 s expiry slack, so without this an idle app makes
   * the browse link a silent no-op until some other call happens to refresh.
   */
  async resolveSiteUrl(instanceId: string): Promise<string | null> {
    const cached = this.cloudId.get(instanceId)
    if (cached) return cached.siteUrl
    try {
      const auth = this.creds()
      if (!auth.oauth) return null
      let token = auth.oauth.accessToken()
      if (!token) {
        await auth.oauth.refresh()
        token = auth.oauth.accessToken()
      }
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
      attachments,
      cloneLinks: cloneLinksOf(f, this.cloneLinkTypes())
    }
    return { preview, descriptionMarkdown: adfToMarkdown(f.description), raw }
  }

  /**
   * JQL search — the only thing on this client a routine's scope resolver calls.
   *
   * `/rest/api/3/search/jql` with a page token, not the deprecated offset-based
   * `/rest/api/3/search`. This shape is documented, not observed: the Task 6 live-instance
   * spike (plan step) could not run in this environment (no Atlassian credentials available),
   * so the endpoint path, the `nextPageToken` field name, and the presence of `fields.created`
   * are unverified assumptions taken from Jira Cloud's published docs, not a captured
   * response. Treat them as unconfirmed until the live exit-check runs against a real
   * instance — do not "correct" this shape from the SDK types or the docs without capturing
   * a real response first.
   *
   * Returns only the key and the two cursor fields. Everything else a routine needs about a
   * ticket comes from the existing ingest path, which already fetches the full issue — asking
   * for it twice would double the request volume of a nightly sweep for nothing.
   */
  async searchIssues(
    jql: string,
    opts: { maxResults?: number; pageToken?: string }
  ): Promise<JiraSearchPage> {
    const params = new URLSearchParams({
      fields: 'created,updated',
      maxResults: String(opts.maxResults ?? 50)
    })
    if (opts.pageToken) params.set('nextPageToken', opts.pageToken)
    // jql is appended via encodeURIComponent rather than folded into URLSearchParams: the
    // latter's form-encoding turns spaces into `+`, not `%20`, which is a perfectly valid
    // query string but makes the raw request URL harder to eyeball/diff in logs.
    const res = await this.request(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&${params.toString()}`
    )
    const body = await this.parseJson<{
      issues?: Array<{ key: string; fields?: { created?: string; updated?: string } }>
      nextPageToken?: string
    }>(res)
    return {
      issues: (body.issues ?? []).map((i) => ({
        key: i.key,
        // A missing fields block is not worth failing a whole nightly sweep over, so it becomes
        // an EMPTY cursor value here rather than an exception. It is NOT a usable value: the
        // previous comment claimed the empty string "sorts before every real timestamp, so such
        // an item is simply processed first", which reasoned about a local sort that never
        // happens — JIRA does the ordering, and this string never reaches a comparison. What it
        // reaches is the routine's cursor, where '' reads back as falsy and restarts the scope
        // from the beginning of the project (a permanent, silent stall). Consumers must drop
        // these: buildJiraScopeResolver (jiraScopeResolver.ts) skips them at resolution with a
        // logged reason, and routines/cursors.ts refuses to persist a blank cursor at all.
        created: i.fields?.created ?? '',
        updated: i.fields?.updated ?? ''
      })),
      nextPageToken: body.nextPageToken ?? null
    }
  }

  /**
   * The site's issue link-type catalogue — what Settings → Connectors offers as clone link types
   * instead of asking the user to type a name that has to match Jira exactly (user-directed,
   * 2026-08-21). A mismatch there is silent: discovery just finds nothing.
   *
   * Unpaginated on purpose: the endpoint returns the whole catalogue in one response and a site
   * has a handful of link types, not pages of them. Entries without a string `name` are dropped
   * rather than failing the call — the name is the only field the caller stores.
   */
  async issueLinkTypes(): Promise<JiraLinkType[]> {
    const res = await this.request('/rest/api/3/issueLinkType')
    const body = await this.parseJson<{
      issueLinkTypes?: Array<{ id?: unknown; name?: unknown; inward?: unknown; outward?: unknown }>
    }>(res)
    return (body.issueLinkTypes ?? [])
      .filter((t): t is { id?: unknown; name: string } & typeof t => typeof t.name === 'string')
      .map((t) => ({
        id: String(t.id ?? t.name),
        name: t.name,
        ...(typeof t.inward === 'string' ? { inward: t.inward } : {}),
        ...(typeof t.outward === 'string' ? { outward: t.outward } : {})
      }))
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

  /** Upload one file as an issue attachment (proven against the gateway 2026-08-03 —
   *  write:jira-work covers it; X-Atlassian-Token: no-check is required or Jira 403s).
   *  The FormData/Blob body is safely re-sent by request()'s 401/403 retry: Blob parts
   *  are re-readable (verified empirically — two sequential fetch() calls against the
   *  same FormData instance both transmit the full body), so no per-attempt rebuild is
   *  needed. */
  async uploadAttachment(
    key: string,
    filename: string,
    content: string
  ): Promise<{ id: string; filename: string }> {
    const form = new FormData()
    form.append('file', new Blob([content], { type: 'text/markdown' }), filename)
    const res = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, {
      method: 'POST',
      body: form,
      headers: { 'X-Atlassian-Token': 'no-check' }
    })
    const arr = await this.parseJson<Array<{ id?: unknown; filename?: unknown }>>(res)
    const a = arr[0]
    if (!a)
      throw new AtlassianError(
        'http',
        'Attachment upload returned no records',
        this.creds().instanceId
      )
    return { id: String(a.id ?? ''), filename: String(a.filename ?? filename) }
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
/**
 * A Jira REST timestamp, split into the parts a JQL date literal is made of.
 *
 * Jira renders every `created`/`updated` value as ISO 8601 with an EXPLICIT offset —
 * `2026-08-03T15:36:14.574+0200` — and that offset is the searching account's own, because Jira
 * renders timestamps in the account's timezone. That is the single fact `jiraDate` is built on.
 *
 * Group 6 is the offset and is OPTIONAL on purpose: a value that carries none is the one input
 * `jiraDate` cannot place on a clock exactly, and matching it here (rather than failing the match)
 * is what lets that case take the documented fallback instead of the throw.
 *
 * Seconds and fractional seconds are matched but not captured — JQL has minute resolution and
 * drops them itself.
 */
const JIRA_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/

/**
 * How far back the cursor literal is nudged when it carries NO timezone offset of its own.
 *
 * WHEN THIS IS REACHED, AND WHY IT SHOULD BE NEVER: `jiraDate` formats the cursor in the offset
 * the cursor itself carries, so a cursor that came from Jira never gets here. Only a value that is
 * not a Jira timestamp does — a hand-edited `routine_cursors` row, a cursor migrated in from
 * somewhere else, or a future Jira that stops emitting offsets. It is a safety net for data this
 * app did not produce, not a normal path.
 *
 * 12 hours because the westernmost real UTC offset is -12:00: Jira reads a bare literal as
 * wall-clock time in the account's zone, so the instant it actually means is at worst
 * `literal - offset`, and starting 12h before the cursor's own wall clock makes the bound never
 * LATER than the cursor for any account on earth. Erring late would skip tickets permanently and
 * invisibly; erring early only re-examines tickets already attempted, which `attemptedItemKeys`
 * filters out.
 *
 * WHAT IT COSTS, PRECISELY. A `jira-jql` run fetches `maxItemsPerRun + CURSOR_BOUNDARY_SLACK` rows
 * ascending (services/routines/service.ts) and filters already-attempted keys AFTER the query, so
 * once the widened window holds that many already-attempted items, every fetched row is one of
 * them and the run selects zero. That is not theoretical: it was reached against a real Jira
 * instance within seven runs while this margin was the only path.
 *
 * THE REMEDIATION IS NOT A RE-AUTHORIZATION. An earlier version of this fallback told the user to
 * re-authorize the connector so the account's timezone could be read from `/rest/api/3/myself`.
 * Measured against a live instance, that is false twice over: `/myself` needs the `read:jira-user`
 * scope, which the connector's preset does not grant and re-consenting does not add, and the zone
 * is no longer needed at all. If a routine does reach this fallback, the fix is to make its cursor
 * a real Jira timestamp again — deleting and recreating the routine drops the cursor row
 * (`forgetRoutineCursor`) and restarts it unbounded.
 *
 * `resolveTargets` (services/routines/service.ts) independently detects the saturated window this
 * describes and refuses to report a clean `ok` for it, so the stall is loud wherever it comes from.
 */
export const JIRA_CURSOR_UNKNOWN_ZONE_MARGIN_MS = 12 * 60 * 60 * 1000

/**
 * Formats a Jira timestamp as a JQL date literal — `yyyy-MM-dd HH:mm` — IN THE OFFSET THE
 * TIMESTAMP ITSELF CARRIES.
 *
 * HOW JIRA READS THIS LITERAL IS THE WHOLE POINT, and getting it wrong is silent both ways. JQL
 * has no timezone syntax at all: `created >= "2026-08-09 10:00"` is wall-clock time in the
 * timezone of the ACCOUNT running the search — proven against a live instance with two identical
 * 34-minute windows shifted by two hours, of which only the account-local one matched. An instant
 * formatted in the wrong zone becomes a bound at the wrong moment, off by the whole offset:
 *   - account BEHIND UTC (say UTC-7) and the literal formatted in UTC -> the bound lands 7 hours
 *     LATER than intended, and every ticket in that window is skipped PERMANENTLY, because the
 *     cursor only ever moves forward. The run reports `ok`.
 *   - account AHEAD of UTC (say UTC+2) -> the bound lands earlier, the
 *     `maxItemsPerRun + CURSOR_BOUNDARY_SLACK` window fills with already-attempted keys, zero
 *     items are selected, and the routine stalls. The run also reports `ok`. This one was reached
 *     live, on a real instance, in a day.
 *
 * WHY NO ZONE ARGUMENT, AND NO LOOKUP. The only input is the cursor, and the cursor IS a Jira
 * timestamp: Jira renders `created`/`updated` in the searching account's zone and stamps the
 * offset on the value (`...+0200`). The wall clock Jira will read the literal as is therefore
 * already written in the string — its date and time components, verbatim. No request, no OAuth
 * scope and no DST reasoning, because the offset was computed by Jira for that very instant rather
 * than inferred from a zone name and a rule table.
 *
 * The previous version asked `/rest/api/3/myself` for the account's IANA zone. That endpoint
 * answers `401 "Unauthorized; scope does not match"` with the scopes this app's connector holds —
 * on every call, permanently — so the lookup could never succeed in production, and every run paid
 * a wasted token refresh for it. It is deleted rather than kept as an "optimisation": there is
 * nothing left for it to optimise, and a dead path that looks live is worse than no path.
 *
 * A value carrying no offset at all cannot be placed on a clock exactly, and falls back to
 * `JIRA_CURSOR_UNKNOWN_ZONE_MARGIN_MS` — a bound that is never late for any account, at the cost
 * written down on that constant. Read it before touching this.
 *
 * JQL date/time comparisons have MINUTE resolution — seconds (and anything finer) are silently
 * dropped by Jira itself, not by this function. That loss is only safe because the scope
 * resolver's cursor boundary is INCLUSIVE (`>=`, jiraScopeResolver.ts): a strict `>` combined with
 * this precision loss would drop every ticket sharing the cursor's minute, permanently and
 * silently, whenever more than one ticket lands in the same minute. items.ts removes the resulting
 * duplicate by key instead.
 *
 * This truncation is also what widens the "boundary" `CURSOR_BOUNDARY_SLACK`
 * (services/routines/service.ts) accepts a residual starvation risk on: that constant was sized
 * when a shared boundary meant an identical timestamp, and this function's minute-rounding turns
 * it into a whole-minute-wide bucket instead — roughly sixty times wider. See that docblock.
 *
 * NOT the host machine's local zone, in either branch: reading it would make the bound query — and
 * every test of it — depend on where the laptop happens to be, which is unrelated to how Jira will
 * evaluate the literal. The fallback branch composes its instant with `Date.UTC` for exactly that
 * reason: `new Date('2026-08-03T15:34:00')` (no offset) is parsed by the JS runtime as LOCAL time,
 * which would make the one input that already lost its offset depend on the laptop's.
 *
 * THROWS on a value that is not a timestamp at all. The alternative is emitting `NaN-NaN-NaN` into
 * a JQL string, which produces an opaque Jira 400; a thrown error fails the same run with a
 * readable reason. The cursor is refused empty at the write (routines/cursors.ts), so reaching
 * this needs a stored value that never came from Jira.
 */
export function jiraDate(iso: string): string {
  const m = JIRA_TIMESTAMP.exec(iso.trim())
  if (m?.[6]) {
    // The components ARE the account's wall clock for this instant — that is what an explicit
    // offset means. There is nothing to convert, and converting is precisely the bug.
    const [, y, mo, da, h, mi] = m
    return `${y}-${mo}-${da} ${h}:${mi}`
  }
  const ms = m
    ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
    : new Date(iso).getTime()
  if (!Number.isFinite(ms)) {
    throw new Error(
      `Cannot build a JQL date literal from ${JSON.stringify(iso)}: it is not a timestamp.`
    )
  }
  const pad = (n: number): string => String(n).padStart(2, '0')
  const back = new Date(ms - JIRA_CURSOR_UNKNOWN_ZONE_MARGIN_MS)
  return (
    `${back.getUTCFullYear()}-${pad(back.getUTCMonth() + 1)}-${pad(back.getUTCDate())} ` +
    `${pad(back.getUTCHours())}:${pad(back.getUTCMinutes())}`
  )
}
