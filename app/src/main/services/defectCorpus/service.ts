// Multi-source fan-out over the Defect Corpus client (Task 1) + configured sources
// (Task 2). A dead/unconfigured corpus must never degrade triage (SPEC §5 in the
// design doc) — every public method here resolves, never rejects, and a missing
// token short-circuits before any network call.
import {
  DefectCorpusClient,
  type CorpusInfo,
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
