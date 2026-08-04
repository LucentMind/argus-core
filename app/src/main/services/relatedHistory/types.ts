import type { RelatedHit, RelatedProviderKind, RelatedReason } from '../../../shared/relatedHistory'

/**
 * Placeholder for the query object Task 3's FTS query builder will produce
 * (`relatedHistory/query.ts` does not exist yet — that module is out of
 * scope for Task 1). Only its use as an opaque parameter type matters here;
 * Task 3 is expected to replace this with an import from the real module.
 */
export interface RelatedQuery {
  raw: string
}

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
