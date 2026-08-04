// Wire shapes for the unified related-history surface (spec §3.1). Types only —
// this file is imported by the renderer, so it must never reach into main/*.

export type RelatedProviderKind = 'local' | 'corpus'
export type RelatedMatchedOn = 'lexical' | 'semantic' | 'both'
export type RelatedStatusTone = 'open' | 'resolved' | 'forwarded'
export type RelatedReason = 'query-too-generic' | 'no-providers'

export interface RelatedProvenance {
  providerId: string
  providerName: string
  kind: RelatedProviderKind
}

/** The shape SPEC §6 deliberately aligned between corpus records and local
 *  case_summaries. `terms` holds local `keywords` OR corpus `errorStrings`; the
 *  UI labels it per `kind` so neither is misrepresented as the other. */
export interface RelatedDistilled {
  signature: string
  symptoms: string
  rootCause: string | null
  fix: string | null
  terms: string[]
}

export interface CorpusRef {
  sourceId: string
  key: string
  url: string
}

interface RelatedHitCommon {
  /** `${providerId}:${nativeKey}` — React key and the fusion dedupe key. */
  id: string
  /** More than one entry only on a merged local+corpus row (spec §3.3). */
  provenance: RelatedProvenance[]
  title: string
  snippet: string | null
  matchedOn: RelatedMatchedOn
  /** 1-based rank WITHIN its own provider — the only cross-source comparable
   *  signal, since SPEC §5 refuses score normalization. */
  rank: number
  fusedScore: number
  status: { label: string; tone: RelatedStatusTone }
  distilled: RelatedDistilled | null
}

export type LocalCaseHit = RelatedHitCommon & {
  kind: 'local'
  caseSlug: string
  jiraKey: string | null
  /** Set only when a corpus hit merged into this row. */
  corpusRef?: CorpusRef
}

export type CorpusDefectHit = RelatedHitCommon & { kind: 'corpus' } & CorpusRef

export type RelatedHit = LocalCaseHit | CorpusDefectHit

/** `'service'` marks a failure of the retrieval service itself, before any
 *  provider was consulted — it is not a provider kind. */
export type SourceHealthKind = RelatedProviderKind | 'service'

export interface SourceHealth {
  id: string
  name: string
  kind: SourceHealthKind
  ok: boolean
  error?: string
  code?: string
}

export interface RelatedSearchResult {
  /** Resolved query text, echoed so a caller can prefill a search box. */
  query: string
  hits: RelatedHit[]
  /** EVERY provider, healthy ones included — this is what makes "nothing
   *  similar" distinguishable from "the corpus is down". */
  sources: SourceHealth[]
  reason?: RelatedReason
}

/** At least one of `caseSlug` / `query` is required. `caseSlug` alone means
 *  "compose the query from the case"; `query` alone means free-form. */
export interface RelatedSearchInput {
  caseSlug?: string
  query?: string
  limit?: number
}
