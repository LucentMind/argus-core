import type {
  RelatedFilters,
  RelatedHit,
  RelatedProviderKind,
  RelatedReason,
  RelatedSearchMode
} from '../../../shared/relatedHistory'
import type { RelatedQuery } from './query'

export type ProviderResult =
  | { ok: true; hits: RelatedHit[]; reason?: RelatedReason }
  | { ok: false; error: string; code?: string }

/**
 * Explorer-only knobs. A THIRD, OPTIONAL parameter rather than a replacement for
 * `limit`: increment 1's suite calls `search(q, n)` at ~25 sites, and churning
 * all of them to carry an options object would be diff for its own sake. `limit`
 * stays positional because every caller always supplies it.
 */
export interface ProviderSearchOptions {
  /** Corpus-only. */
  mode?: RelatedSearchMode
  /** Corpus-only. */
  filters?: RelatedFilters
  /** Local-only: search `resolution:'open'` summaries too. */
  includeOpen?: boolean
}

export interface HistoryProvider {
  readonly id: string
  readonly name: string
  readonly kind: RelatedProviderKind
  search(q: RelatedQuery, limit: number, opts?: ProviderSearchOptions): Promise<ProviderResult>
}

/** One provider's ranked output, ready for fusion. `order` is the provider's
 *  position in configuration order — fusion tie-break level 3. */
export interface ProviderRanking {
  providerId: string
  providerName: string
  kind: RelatedProviderKind
  order: number
  hits: RelatedHit[]
}
