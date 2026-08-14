import type { CaseRecord } from '../../../shared/types'

/**
 * Case-grid orderings offered by the dashboard's Sort menu.
 *
 * `triage` is the default and is NOT re-sorted here — it is whatever order `listCases`
 * returned (action items first, then updatedAt desc, then priority, then id desc). Keeping it
 * as a pass-through means the triage ranking has exactly one implementation, in main, instead
 * of a renderer copy free to drift from it.
 */
export type CaseSortField = 'triage' | 'worked' | 'updated'

export type SortDirection = 'desc' | 'asc'

export const CASE_SORT_FIELDS: readonly CaseSortField[] = ['triage', 'worked', 'updated']

export const CASE_SORT_LABEL: Record<CaseSortField, string> = {
  triage: 'Triage',
  worked: 'Recently worked on',
  updated: 'Updated'
}

/** Direction wording is per-field: "newest/oldest" reads wrong for a rank, and `triage` has
 *  no direction at all (the toggle is hidden for it). */
export const DIRECTION_LABEL: Record<SortDirection, string> = {
  desc: 'newest first',
  asc: 'oldest first'
}

export function isCaseSortField(v: unknown): v is CaseSortField {
  return CASE_SORT_FIELDS.includes(v as CaseSortField)
}

export function isSortDirection(v: unknown): v is SortDirection {
  return v === 'desc' || v === 'asc'
}

/** The timestamp a field ranks on. Null means "no such moment exists for this case". */
function keyOf(c: CaseRecord, field: Exclude<CaseSortField, 'triage'>): string | null {
  return field === 'worked' ? c.lastWorkedAt : c.updatedAt
}

/**
 * Order a case list for display. Pure — returns a new array, never mutates `cases`.
 *
 * Cases with no timestamp for the chosen field (a case nobody has run a turn in has
 * `lastWorkedAt === null`) sort LAST in BOTH directions. They are not "the oldest work"; there
 * is no work. Sinking them keeps "oldest first" a list of stale cases rather than a list of
 * empty ones, which is the question that ordering is asked to answer.
 *
 * Ties break on slug so the grid is totally ordered and cannot reshuffle between renders —
 * `updatedAt` is an ISO string at millisecond resolution and two cases touched in the same
 * millisecond are routine after a `Sync all`.
 */
export function sortCases(
  cases: CaseRecord[],
  field: CaseSortField,
  direction: SortDirection
): CaseRecord[] {
  if (field === 'triage') return cases
  const sign = direction === 'desc' ? -1 : 1
  return [...cases].sort((a, b) => {
    const ka = keyOf(a, field)
    const kb = keyOf(b, field)
    if (ka === null || kb === null) {
      if (ka === kb) return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
      return ka === null ? 1 : -1
    }
    if (ka !== kb) return sign * (ka < kb ? -1 : 1)
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  })
}
