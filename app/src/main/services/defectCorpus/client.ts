// Vendored v1 Defect Corpus API client — a thin typed wrapper over the wire
// contract defined by https://github.com/LucentMind/argus-hindsight
// (packages/contract/src/index.ts, SPEC.md §3-4). Error semantics and the
// request chokepoint mirror that repo's reference client
// (packages/client/src/index.ts) 1:1; the request-plumbing shape (injected
// fetchFn default, single chokepoint) follows this app's house style
// (see atlassian.ts AtlassianClient).
import { z } from 'zod'

export const SECRET_MASK = '••••••'

export class CorpusError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'CorpusError'
  }
}

export interface CorpusClientOptions {
  baseUrl: string
  token: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}

const CorpusIssueLink = z.object({
  type: z.enum(['duplicates', 'is-duplicated-by', 'relates', 'blocks', 'is-blocked-by', 'other']),
  key: z.string()
})

const CorpusComment = z.object({ author: z.string(), createdAt: z.string(), body: z.string() })

const CorpusDistilled = z.object({
  signature: z.string(),
  symptoms: z.string(),
  rootCause: z.string().nullable(),
  fix: z.string().nullable(),
  errorStrings: z.array(z.string()),
  distilledAt: z.string()
})

// Response-root schemas get `.passthrough()`: SPEC.md §8 mandates that changes
// within /v1 are additive-only and callers must ignore unknown fields rather
// than reject them — passthrough keeps a v1.1 service's new top-level fields
// in the parsed value instead of silently stripping them. Nested/embedded
// shapes (links, comments, distilled, search hits) are not response roots, so
// they keep zod's default strip behavior.
export const CorpusDefectRecord = z
  .object({
    key: z.string(),
    url: z.string(),
    project: z.string(),
    summary: z.string(),
    description: z.string(),
    status: z.string(),
    resolution: z.string().nullable(),
    components: z.array(z.string()),
    labels: z.array(z.string()),
    affectsVersions: z.array(z.string()),
    fixVersions: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
    resolvedAt: z.string().nullable(),
    links: z.array(CorpusIssueLink),
    commentCount: z.number().int(),
    comments: z.array(CorpusComment).optional(),
    distilled: CorpusDistilled.nullable()
  })
  .passthrough()
export type CorpusDefectRecord = z.infer<typeof CorpusDefectRecord>

export const CorpusSearchHit = z.object({
  key: z.string(),
  url: z.string(),
  score: z.number(),
  matchedOn: z.enum(['lexical', 'semantic', 'both']),
  snippet: z.string(),
  record: CorpusDefectRecord
})
export type CorpusSearchHit = z.infer<typeof CorpusSearchHit>

export const CorpusSearchResponse = z.object({ hits: z.array(CorpusSearchHit) }).passthrough()
export type CorpusSearchResponse = z.infer<typeof CorpusSearchResponse>

export const CorpusInfo = z
  .object({
    name: z.string(),
    contract: z.string(),
    projects: z.array(z.string()),
    ticketCount: z.number().int(),
    lastSyncAt: z.string().nullable(),
    capabilities: z.object({
      semantic: z.boolean(),
      admin: z.boolean(),
      enrichment: z.object({ distilled: z.number().int(), total: z.number().int() })
    })
  })
  .passthrough()
export type CorpusInfo = z.infer<typeof CorpusInfo>

export const CorpusSyncStatus = z
  .object({
    state: z.enum(['idle', 'running', 'error']),
    progress: z
      .object({ fetched: z.number().int(), upserted: z.number().int(), embedded: z.number().int() })
      .nullable(),
    lastSyncAt: z.string().nullable(),
    lastError: z.string().nullable()
  })
  .passthrough()
export type CorpusSyncStatus = z.infer<typeof CorpusSyncStatus>

const CorpusErrorEnvelope = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

const CorpusAdminSyncStarted = z.object({ started: z.boolean() }).passthrough()

// Transcribed from argus-hindsight/packages/contract/src/index.ts:86-99 (`AdminConfig`).
// Root gets `.passthrough()` per the additive-evolution rule (see CorpusDefectRecord
// above); the nested groups (jira/sync/embedding/llm/enrichment) stay plain, matching
// how the reference contract itself does not passthrough them.
export const CorpusAdminConfig = z
  .object({
    jira: z.object({
      baseUrl: z.string(),
      email: z.string(),
      apiToken: z.string().optional(),
      jql: z.string(),
      includeComments: z.boolean()
    }),
    sync: z.object({ intervalMinutes: z.number().int().min(0) }),
    embedding: z.object({
      endpoint: z.string(),
      model: z.string(),
      apiKey: z.string().optional()
    }),
    llm: z.object({
      provider: z.enum(['openai-compatible', 'anthropic']),
      endpoint: z.string().optional(),
      model: z.string(),
      apiKey: z.string().optional()
    }),
    enrichment: z.object({
      mode: z.enum(['off', 'rules', 'on-first-hit']),
      rulesJql: z.string().optional()
    })
  })
  .passthrough()
export type CorpusAdminConfig = z.infer<typeof CorpusAdminConfig>

// Transcribed from argus-hindsight/packages/contract/src/index.ts:111-115 (`JqlPreviewResponse`).
export const CorpusJqlPreview = z
  .object({
    count: z.number().int(),
    sample: z.array(z.object({ key: z.string(), summary: z.string() }))
  })
  .passthrough()
export type CorpusJqlPreview = z.infer<typeof CorpusJqlPreview>

export type CorpusSearchInput = {
  query: string
  mode?: 'hybrid' | 'lexical' | 'semantic'
  filters?: {
    projects?: string[]
    components?: string[]
    resolutions?: string[]
    statuses?: string[]
    fixVersions?: string[]
    updatedAfter?: string
  }
  limit?: number
}

const DEFAULT_TIMEOUT_MS = 5_000 // case-open path budget

export class DefectCorpusClient {
  private readonly base: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(opts: CorpusClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchFn = opts.fetchFn ?? fetch
  }

  /** Single request chokepoint — every method below funnels through this. */
  private async request<T>(
    schema: z.ZodType<T>,
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    let res: Response
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (err) {
      throw new CorpusError('unreachable', err instanceof Error ? err.message : String(err), 0)
    }
    const json = await res.json().catch(() => undefined)
    if (!res.ok) {
      const env = CorpusErrorEnvelope.safeParse(json)
      if (env.success)
        throw new CorpusError(env.data.error.code, env.data.error.message, res.status)
      throw new CorpusError('http_error', `HTTP ${res.status}`, res.status)
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) throw new CorpusError('invalid_response', parsed.error.message, res.status)
    return parsed.data
  }

  info(): Promise<CorpusInfo> {
    return this.request(CorpusInfo, 'GET', '/v1/info')
  }

  // The wire body only carries the keys the caller supplied — mode/limit
  // defaults are applied server-side (SPEC.md §4.2), so a caller sending just
  // `{ query }` must not have mode/limit injected here.
  search(req: CorpusSearchInput): Promise<CorpusSearchResponse> {
    return this.request(CorpusSearchResponse, 'POST', '/v1/search', req)
  }

  getDefect(key: string): Promise<CorpusDefectRecord> {
    return this.request(CorpusDefectRecord, 'GET', `/v1/defects/${encodeURIComponent(key)}`)
  }

  adminSync(): Promise<{ started: boolean }> {
    return this.request(CorpusAdminSyncStarted, 'POST', '/v1/admin/sync')
  }

  adminSyncStatus(): Promise<CorpusSyncStatus> {
    return this.request(CorpusSyncStatus, 'GET', '/v1/admin/sync/status')
  }

  adminGetConfig(): Promise<CorpusAdminConfig> {
    return this.request(CorpusAdminConfig, 'GET', '/v1/admin/config')
  }

  adminPutConfig(cfg: CorpusAdminConfig): Promise<CorpusAdminConfig> {
    return this.request(CorpusAdminConfig, 'PUT', '/v1/admin/config', cfg)
  }

  adminJqlPreview(jql: string): Promise<CorpusJqlPreview> {
    return this.request(CorpusJqlPreview, 'POST', '/v1/admin/jql-preview', { jql })
  }
}
