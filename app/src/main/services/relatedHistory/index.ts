import type { DatabaseSync } from 'node:sqlite'
import type {
  RelatedHit,
  RelatedReason,
  RelatedSearchInput,
  RelatedSearchResult,
  SourceHealth
} from '../../../shared/relatedHistory'
import type { DefectCorpusService } from '../defectCorpus/service'
import { summaryPopulation } from '../distill/summaries'
import { fuse } from './fuse'
import { buildRelatedQuery, freeFormQuery, type RelatedQuery } from './query'
import { createCorpusProviders } from './providers/corpus'
import { createLocalCasesProvider } from './providers/localCases'
import type { HistoryProvider, ProviderRanking } from './types'

export { fuse, RRF_K, rrfScore } from './fuse'
export type { HistoryProvider, ProviderRanking, ProviderResult } from './types'

const DEFAULT_LIMIT = 5

/** Identity for the synthetic `SourceHealth` entry used when the pre-fan-out
 *  path itself throws (query resolution, provider discovery) — see `search`. */
const SERVICE_SOURCE_ID = 'related-history'
const SERVICE_SOURCE_NAME = 'Related history'

export interface RelatedHistoryDeps {
  db: DatabaseSync
  defectCorpus: DefectCorpusService
  /** Test seam — when set, replaces provider discovery entirely. */
  providers?: HistoryProvider[]
}

/**
 * Unified related-history retrieval (spec §2). Fans out over providers, fuses by
 * reciprocal rank, and reports EVERY provider's health so a caller can tell
 * "nothing similar" apart from "the corpus is down".
 *
 * Never rejects — mirroring DefectCorpusService's contract, because this sits on
 * the case-open path and a dead source must never degrade triage. That covers
 * more than the provider fan-out: query resolution (`buildRelatedQuery` reads
 * `cases`/`case_summaries`/`findings`) and provider discovery
 * (`summaryPopulation`, settings reads) are raw, synchronous DB/settings calls
 * that can throw (a corrupt FTS5 shadow table, `SQLITE_BUSY` in a multi-window
 * app, a broken settings read) — so the WHOLE method body is guarded, not just
 * the per-provider `search` calls. A failure there never collapses to a bare
 * empty result (that would hide it, the exact bug this feature replaces): it
 * surfaces as a single synthetic failed `SourceHealth` entry instead.
 */
export class RelatedHistoryService {
  constructor(private deps: RelatedHistoryDeps) {}

  async search(input: RelatedSearchInput): Promise<RelatedSearchResult> {
    // `freeFormQuery` is pure and cannot throw, so whenever the caller supplied
    // `query` the echo is knowable even if everything after this point fails —
    // seed it up front rather than only after `resolveQuery` returns.
    let queryText = input.query ?? ''
    try {
      const limit = input.limit ?? DEFAULT_LIMIT
      const query = this.resolveQuery(input)
      queryText = query.text
      const providers = this.providers(input.caseSlug ?? null)

      if (providers.length === 0) {
        return { query: query.text, hits: [], sources: [], reason: 'no-providers' }
      }

      const sources: SourceHealth[] = []
      const rankings: ProviderRanking[] = []
      let candidateReason: RelatedReason | undefined

      // Promise.all's resolved array always mirrors the input array's order, no
      // matter which provider settles first — so the forEach index below is
      // genuinely the provider's configuration index, not an artifact of timing.
      const settled = await Promise.all(
        providers.map(async (p) => {
          try {
            return { p, res: await p.search(query, limit) }
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err)
            return { p, res: { ok: false as const, error } }
          }
        })
      )

      settled.forEach(({ p, res }, order) => {
        if (!res.ok) {
          sources.push({
            id: p.id,
            name: p.name,
            kind: p.kind,
            ok: false,
            error: res.error,
            ...(res.code ? { code: res.code } : {})
          })
          return
        }
        sources.push({ id: p.id, name: p.name, kind: p.kind, ok: true })
        if (res.reason && !candidateReason) candidateReason = res.reason
        // `order` is the forEach index over EVERY settled provider (failed ones
        // included), so it still equals this provider's configuration index even
        // when an earlier provider failed and was skipped above — never the
        // count of successes seen so far.
        rankings.push({
          providerId: p.id,
          providerName: p.name,
          kind: p.kind,
          order,
          hits: res.hits
        })
      })

      const hits: RelatedHit[] = fuse(rankings).slice(0, limit)
      // A provider's own "nothing worth showing" reason (e.g. `query-too-generic`
      // from the local guards) only describes THAT provider's contribution. Per
      // the design spec the UI renders nothing at all when `reason` is set, so
      // surfacing a benign per-provider reason while a DIFFERENT provider found
      // real hits would hide those hits behind a reason that no longer matches
      // the aggregate result — attach it only when the fused list is empty.
      //
      // Further: even when hits ARE empty, a reason must not paper over a
      // failed source. If any provider is down, the caller needs to render
      // that degraded state (its own health chrome), not the generic "nothing
      // matched" reason — otherwise a dead corpus goes invisible again, which
      // is the original bug this whole feature exists to fix, just relocated
      // from `hits` to `reason`.
      const allHealthy = sources.every((s) => s.ok)
      const reason = hits.length === 0 && allHealthy ? candidateReason : undefined
      return { query: query.text, hits, sources, ...(reason ? { reason } : {}) }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return {
        query: queryText,
        hits: [],
        sources: [
          { id: SERVICE_SOURCE_ID, name: SERVICE_SOURCE_NAME, kind: 'service', ok: false, error }
        ]
      }
    }
  }

  /** An explicit `query` always wins: it means the user typed in the box. */
  private resolveQuery(input: RelatedSearchInput): RelatedQuery {
    if (input.query !== undefined) return freeFormQuery(input.query)
    if (input.caseSlug) return buildRelatedQuery(this.deps.db, input.caseSlug)
    return { text: '', terms: [] }
  }

  /**
   * Local first (tie-break level 2 prefers it anyway), then one provider per
   * enabled corpus source in settings order.
   *
   * The local provider is skipped when there are no searchable summaries at all,
   * which is what gives `no-providers` a real trigger: a fresh install with
   * nothing distilled and no corpus configured.
   */
  private providers(caseSlug: string | null): HistoryProvider[] {
    if (this.deps.providers) return this.deps.providers
    const out: HistoryProvider[] = []
    if (summaryPopulation(this.deps.db, true) > 0) {
      out.push(createLocalCasesProvider(this.deps.db, caseSlug))
    }
    out.push(...createCorpusProviders(this.deps.defectCorpus))
    return out
  }
}
