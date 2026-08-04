import type { RelatedHit, RelatedProviderKind, RelatedReason } from '../../../shared/relatedHistory'
import type { RelatedQuery } from './query'

export type ProviderResult =
  | { ok: true; hits: RelatedHit[]; reason?: RelatedReason }
  | { ok: false; error: string; code?: string }

export interface HistoryProvider {
  readonly id: string
  readonly name: string
  readonly kind: RelatedProviderKind
  search(q: RelatedQuery, limit: number): Promise<ProviderResult>
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
