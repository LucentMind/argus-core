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

/** Corpus-only (SPEC §5). The local provider is lexical, always. */
export type RelatedSearchMode = 'hybrid' | 'lexical' | 'semantic'

/** Corpus-only facets, forwarded verbatim to `POST /v1/search` (SPEC §4.2). The
 *  local provider has no equivalent fields and is never sent these. */
export interface RelatedFilters {
  projects?: string[]
  components?: string[]
  resolutions?: string[]
  statuses?: string[]
  fixVersions?: string[]
  /** ISO 8601. */
  updatedAfter?: string
}

/** Server-enforced maximum on `POST /v1/search` (SPEC §4.2), mirrored here so the
 *  IPC clamp and the explorer's "show more" ceiling are the same number. */
export const RELATED_SEARCH_MAX_LIMIT = 50

/** At least one of `caseSlug` / `query` is required. `caseSlug` alone means
 *  "compose the query from the case"; `query` alone means free-form; both means
 *  case-scoped but the user edited the box (the case is still excluded from
 *  local results). */
export interface RelatedSearchInput {
  caseSlug?: string
  query?: string
  limit?: number
  /** Corpus-only. Omitted means the server's default ('hybrid'). */
  mode?: RelatedSearchMode
  /** Corpus-only. */
  filters?: RelatedFilters
  /** Local-only: include the `resolution: 'open'` rows staging.ts writes for
   *  live cases, which "past cases" excludes by default. */
  includeOpenCases?: boolean
  /** Restrict the fan-out to these provider ids ('local' | `corpus:${sourceId}`).
   *  Absent means every configured provider. */
  providerIds?: string[]
}

/** A source's standing capabilities, probed on demand — NOT per-search health.
 *  `SourceHealth` describes one search's outcome; this describes what a source
 *  can do and which projects it holds. Kept apart deliberately: filling
 *  `semantic` on `SourceHealth` would put a `/v1/info` round-trip on the
 *  case-open path, whose budget is 5s. */
export interface RelatedSourceInfo {
  /** The PROVIDER id, so it lines up with `SourceHealth.id`. */
  id: string
  name: string
  /** `'service'` marks a failure before any source was consulted — same
   *  convention, and the same union, as `SourceHealth.kind`. */
  kind: SourceHealthKind
  ok: boolean
  error?: string
  code?: string
  /** `capabilities.semantic` from `/v1/info`; always false for local. */
  semantic: boolean
  /** `/v1/info` `projects` — the only facet the contract enumerates. */
  projects: string[]
}

export type RelatedDefectLinkType =
  | 'duplicates'
  | 'is-duplicated-by'
  | 'relates'
  | 'blocks'
  | 'is-blocked-by'
  | 'other'

/**
 * Renderer-safe mirror of the corpus `DefectRecord` (SPEC §6). Defined natively
 * here rather than re-exported from `shared/defectCorpus.ts`, which reaches into
 * `main/services/*` and is therefore preload-only — `tsconfig.web.json` excludes
 * `src/main`, so the renderer importing that file breaks `typecheck:web`.
 * Preload's `related.defect` is annotated with `RelatedDefectResult`, which is
 * where a drift between this shape and the zod schema gets caught.
 */
export interface RelatedDefectRecord {
  key: string
  url: string
  project: string
  summary: string
  /** Already normalized to markdown by the service (SPEC §6) — no ADF here. */
  description: string
  status: string
  resolution: string | null
  components: string[]
  labels: string[]
  affectsVersions: string[]
  fixVersions: string[]
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  links: Array<{ type: RelatedDefectLinkType; key: string }>
  commentCount: number
  comments?: Array<{ author: string; createdAt: string; body: string }>
  distilled: {
    signature: string
    symptoms: string
    rootCause: string | null
    fix: string | null
    errorStrings: string[]
    distilledAt: string
  } | null
}

export type RelatedDefectResult =
  | { ok: true; value: RelatedDefectRecord }
  | { ok: false; error: string; code?: string }
