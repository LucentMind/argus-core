// Multi-source fan-out over the Defect Corpus client (Task 1) + configured sources
// (Task 2). A dead/unconfigured corpus must never degrade triage (SPEC §5 in the
// design doc) — every public method here resolves, never rejects, and a missing
// token short-circuits before any network call.
import {
  CorpusError,
  DefectCorpusClient,
  type CorpusAdminConfig,
  type CorpusInfo,
  type CorpusJqlPreview,
  type CorpusSearchHit,
  type CorpusSearchInput,
  type CorpusSyncStatus
} from './client'
import type { DefectCorpusSourceCfg } from '../../../shared/defectCorpus'

export interface DefectCorpusDeps {
  sources: () => Record<string, DefectCorpusSourceCfg> // from settings
  token: (id: string) => string | undefined // secretStore.resolve(corpusTokenSecret(id))
  fetchFn?: typeof fetch
  timeoutMs?: number
}

export interface SourceSearchResult {
  sourceId: string
  sourceName: string
  ok: boolean
  error?: string
  hits: CorpusSearchHit[]
}

const NO_TOKEN_ERROR = 'no token configured'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type ResolvedClient = { ok: true; client: DefectCorpusClient } | { ok: false; error: string }

/**
 * Failure arm carries `code` whenever the client threw a CorpusError (e.g.
 * 'not_configured' | 'forbidden' | 'invalid_jql' | 'unreachable' |
 * 'http_error' | 'invalid_response') so the renderer can branch on the code,
 * never on message text. `code` is absent only for the resolveClient
 * short-circuits (unknown source / missing token), which never reach the
 * client.
 */
export type CorpusAdminResult<T> =
  { ok: true; value: T } | { ok: false; error: string; code?: string }

export class DefectCorpusService {
  constructor(private deps: DefectCorpusDeps) {}

  /** Enabled sources only, in settings key order — for UI listings. */
  enabledSources(): Array<{ id: string; name: string; baseUrl: string }> {
    return Object.entries(this.deps.sources())
      .filter(([, cfg]) => cfg.enabled)
      .map(([id, cfg]) => ({ id, name: cfg.name, baseUrl: cfg.baseUrl }))
  }

  /**
   * Parallel, per-source isolation: NEVER rejects. Disabled sources are skipped
   * entirely (not reported as a failed entry). Result order follows settings key
   * order (Object.entries preserves insertion order for string keys).
   */
  async searchAll(req: CorpusSearchInput): Promise<SourceSearchResult[]> {
    const entries = Object.entries(this.deps.sources()).filter(([, cfg]) => cfg.enabled)
    return Promise.all(
      entries.map(async ([id, cfg]): Promise<SourceSearchResult> => {
        const resolved = this.resolveClient(id, cfg)
        if (!resolved.ok) {
          return { sourceId: id, sourceName: cfg.name, ok: false, error: resolved.error, hits: [] }
        }
        try {
          const res = await resolved.client.search(req)
          return { sourceId: id, sourceName: cfg.name, ok: true, hits: res.hits }
        } catch (err) {
          return {
            sourceId: id,
            sourceName: cfg.name,
            ok: false,
            error: errorMessage(err),
            hits: []
          }
        }
      })
    )
  }

  /** Connectivity check for the Sources settings card. */
  async test(id: string): Promise<{ ok: true; info: CorpusInfo } | { ok: false; error: string }> {
    const resolved = this.resolveClient(id)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    try {
      const info = await resolved.client.info()
      return { ok: true, info }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  }

  /** Trigger an admin sync. A source without the admin tier surfaces its envelope message. */
  async syncNow(id: string): Promise<{ ok: boolean; error?: string }> {
    const resolved = this.resolveClient(id)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    try {
      const res = await resolved.client.adminSync()
      return { ok: res.started }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  }

  /** null on any failure (unknown source, missing token, unreachable, non-admin corpus) — never throws. */
  async syncStatus(id: string): Promise<CorpusSyncStatus | null> {
    const resolved = this.resolveClient(id)
    if (!resolved.ok) return null
    try {
      return await resolved.client.adminSyncStatus()
    } catch {
      return null
    }
  }

  /** Fetch the (secret-masked) admin config for a source. */
  getConfig(id: string): Promise<CorpusAdminResult<CorpusAdminConfig>> {
    return this.adminCall(id, (client) => client.adminGetConfig())
  }

  /** Save the admin config for a source; forwards `cfg` unmodified (server owns masking/merge). */
  putConfig(id: string, cfg: CorpusAdminConfig): Promise<CorpusAdminResult<CorpusAdminConfig>> {
    return this.adminCall(id, (client) => client.adminPutConfig(cfg))
  }

  /** Preview how many/which tickets a JQL string would match, without running a sync. */
  jqlPreview(id: string, jql: string): Promise<CorpusAdminResult<CorpusJqlPreview>> {
    return this.adminCall(id, (client) => client.adminJqlPreview(jql))
  }

  /** Shared shape for the admin passthroughs above: resolve, call, and carry the CorpusError code. */
  private async adminCall<T>(
    id: string,
    fn: (client: DefectCorpusClient) => Promise<T>
  ): Promise<CorpusAdminResult<T>> {
    const resolved = this.resolveClient(id)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    try {
      return { ok: true, value: await fn(resolved.client) }
    } catch (err) {
      return {
        ok: false,
        error: errorMessage(err),
        code: err instanceof CorpusError ? err.code : undefined
      }
    }
  }

  /** Single chokepoint: source lookup + token resolution, shared by every method above. */
  private resolveClient(id: string, cfg?: DefectCorpusSourceCfg): ResolvedClient {
    const source = cfg ?? this.deps.sources()[id]
    if (!source) return { ok: false, error: 'unknown source' }
    const token = this.deps.token(id)
    if (!token) return { ok: false, error: NO_TOKEN_ERROR }
    return {
      ok: true,
      client: new DefectCorpusClient({
        baseUrl: source.baseUrl,
        token,
        timeoutMs: this.deps.timeoutMs,
        fetchFn: this.deps.fetchFn
      })
    }
  }
}
