// Multi-source fan-out over the Defect Corpus client (Task 1) + configured sources
// (Task 2). A dead/unconfigured corpus must never degrade triage (SPEC §5 in the
// design doc) — every public method here resolves, never rejects, and a missing
// token short-circuits before any network call.
import {
  CorpusError,
  DefectCorpusClient,
  type CorpusAdminConfig,
  type CorpusDefectRecord,
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
  /** Present when the failure came from a CorpusError, so a caller can branch on
   *  the code rather than on message text. */
  code?: string
  hits: CorpusSearchHit[]
}

const NO_TOKEN_ERROR = 'no token configured'

// client.ts's DEFAULT_TIMEOUT_MS (5s) is sized for the case-open path (search/test/sync-status)
// — too short for the admin-config passthroughs (Finding 3, final review): adminPutConfig can
// take longer than a case-open budget, and adminJqlPreview runs a live tracker query
// server-side. Precedence (see resolveClient below): an explicit `deps.timeoutMs` — the test
// seam several suites already inject — always wins; ADMIN_TIMEOUT_MS only fills in when that's
// unset; a plain client() call with neither falls back to client.ts's own DEFAULT_TIMEOUT_MS.
const ADMIN_TIMEOUT_MS = 30_000

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
   * Search ONE source. Extracted from searchAll so the related-history module can
   * treat each source as its own ranked provider without re-fanning-out. Never
   * rejects: an unknown source or missing token short-circuits before any network
   * call, and a client throw becomes ok:false carrying the CorpusError code.
   *
   * `cfg` is optional purely to save a settings lookup when the caller already
   * has it (searchAll does).
   */
  async searchOne(
    id: string,
    cfg: DefectCorpusSourceCfg | undefined,
    req: CorpusSearchInput
  ): Promise<SourceSearchResult> {
    const name = cfg?.name ?? this.deps.sources()[id]?.name ?? id
    const resolved = this.resolveClient(id, cfg)
    if (!resolved.ok) {
      return { sourceId: id, sourceName: name, ok: false, error: resolved.error, hits: [] }
    }
    try {
      const res = await resolved.client.search(req)
      return { sourceId: id, sourceName: name, ok: true, hits: res.hits }
    } catch (err) {
      return {
        sourceId: id,
        sourceName: name,
        ok: false,
        error: errorMessage(err),
        code: err instanceof CorpusError ? err.code : undefined,
        hits: []
      }
    }
  }

  /**
   * Parallel, per-source isolation: NEVER rejects. Disabled sources are skipped
   * entirely (not reported as a failed entry). Result order follows settings key
   * order (Object.entries preserves insertion order for string keys).
   */
  async searchAll(req: CorpusSearchInput): Promise<SourceSearchResult[]> {
    const entries = Object.entries(this.deps.sources()).filter(([, cfg]) => cfg.enabled)
    return Promise.all(entries.map(([id, cfg]) => this.searchOne(id, cfg, req)))
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

  /**
   * Full record for one defect key. This is a query-tier endpoint (any user can open a defect
   * detail view), NOT an admin-tier one — `adminCall` is reused here only for its
   * resolve-and-carry-the-error-code envelope shape, not to assert an admin requirement. One
   * consequence of that reuse: this inherits `adminCall`'s 30s timeout budget rather than the 5s
   * case-open budget. That is intentional, not an oversight — `related.defect` is only ever
   * reached from a user click in a later increment, never from the case-open path.
   */
  getDefect(id: string, key: string): Promise<CorpusAdminResult<CorpusDefectRecord>> {
    return this.adminCall(id, (client) => client.getDefect(key))
  }

  /** Shared shape for the admin passthroughs above: resolve, call, and carry the CorpusError code. */
  private async adminCall<T>(
    id: string,
    fn: (client: DefectCorpusClient) => Promise<T>
  ): Promise<CorpusAdminResult<T>> {
    const resolved = this.resolveClient(id, undefined, ADMIN_TIMEOUT_MS)
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

  /**
   * Single chokepoint: source lookup + token resolution, shared by every method above.
   *
   * `timeoutMs` lets a caller (currently only `adminCall`) request a longer budget than the
   * client's own default — but `deps.timeoutMs` (the test seam most of this file's suite
   * already injects) always wins when set, so existing tests that pin a timeout keep getting
   * exactly that value regardless of which call path they exercise.
   */
  private resolveClient(
    id: string,
    cfg?: DefectCorpusSourceCfg,
    timeoutMs?: number
  ): ResolvedClient {
    const source = cfg ?? this.deps.sources()[id]
    if (!source) return { ok: false, error: 'unknown source' }
    const token = this.deps.token(id)
    if (!token) return { ok: false, error: NO_TOKEN_ERROR }
    return {
      ok: true,
      client: new DefectCorpusClient({
        baseUrl: source.baseUrl,
        token,
        timeoutMs: this.deps.timeoutMs ?? timeoutMs,
        fetchFn: this.deps.fetchFn
      })
    }
  }
}
