import {
  RELATED_SEARCH_MAX_LIMIT,
  type RelatedFilters,
  type RelatedSearchInput,
  type RelatedSearchMode
} from '../../../shared/relatedHistory'
import { assertSlug } from '../caseFiles'

const MODES: readonly RelatedSearchMode[] = ['hybrid', 'lexical', 'semantic']
// keep in sync with RelatedFilters (shared/relatedHistory.ts)
const LIST_KEYS = ['projects', 'components', 'resolutions', 'statuses', 'fixVersions'] as const
/** A filter list longer than this is a renderer bug or an attack, not a query. */
const MAX_FILTER_VALUES = 50
const MAX_QUERY_CHARS = 2000
const MAX_PROVIDER_IDS = 32

function strings(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .slice(0, cap)
}

/**
 * The single chokepoint for the untrusted `related:search` payload.
 *
 * Returns a NEW object holding only known keys — never the caller's object with
 * extras spread through — so an unknown field can never reach a corpus request
 * body or a SQL path. Throws (rather than silently coercing) for the cases where
 * a wrong value means a broken caller: an unknown `mode`, an unparseable
 * `updatedAfter`, a bad slug, or neither `caseSlug` nor `query`.
 */
export function validateRelatedSearchInput(raw: unknown): RelatedSearchInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid related search input: ${JSON.stringify(raw)}`)
  }
  const input = raw as Record<string, unknown>
  const out: RelatedSearchInput = {}

  if (input.caseSlug !== undefined) {
    if (typeof input.caseSlug !== 'string') {
      throw new Error(`Invalid case slug: ${JSON.stringify(input.caseSlug)}`)
    }
    assertSlug(input.caseSlug)
    out.caseSlug = input.caseSlug
  }

  if (input.query !== undefined) {
    if (typeof input.query !== 'string') {
      throw new Error(`Invalid related search input: query must be a string`)
    }
    out.query = input.query.slice(0, MAX_QUERY_CHARS)
  }

  if (out.caseSlug === undefined && out.query === undefined) {
    throw new Error('Invalid related search input: one of caseSlug or query is required')
  }

  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
    out.limit = Math.max(1, Math.min(Math.trunc(input.limit), RELATED_SEARCH_MAX_LIMIT))
  }

  if (input.mode !== undefined) {
    if (!MODES.includes(input.mode as RelatedSearchMode)) {
      throw new Error(`Invalid related search mode: ${JSON.stringify(input.mode)}`)
    }
    out.mode = input.mode as RelatedSearchMode
  }

  if (
    typeof input.filters === 'object' &&
    input.filters !== null &&
    !Array.isArray(input.filters)
  ) {
    const src = input.filters as Record<string, unknown>
    const filters: RelatedFilters = {}
    for (const key of LIST_KEYS) {
      const list = strings(src[key], MAX_FILTER_VALUES)
      if (list.length > 0) filters[key] = list
    }
    if (src.updatedAfter !== undefined) {
      const at = src.updatedAfter
      if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
        throw new Error(`Invalid related search filters.updatedAfter: ${JSON.stringify(at)}`)
      }
      filters.updatedAfter = at
    }
    if (Object.keys(filters).length > 0) out.filters = filters
  }

  if (input.includeOpenCases === true) out.includeOpenCases = true

  // Unlike `filters` above, an explicitly empty list here is NOT dropped: the
  // renderer sends `providerIds: []` when the user unchecked every source in
  // the rail, and that has to mean "search nothing" (RelatedHistoryService's
  // `no-providers` path), not "key absent, so unrestricted". Distinguishing
  // "absent" from "empty" on the array itself — not on the length of the
  // strings that survive filtering — is what preserves that distinction.
  if (Array.isArray(input.providerIds)) {
    out.providerIds = strings(input.providerIds, MAX_PROVIDER_IDS)
  }

  return out
}
