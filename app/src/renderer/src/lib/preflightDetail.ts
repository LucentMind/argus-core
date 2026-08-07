const ABSOLUTE_PATH = /^(\/|\\\\|[A-Za-z]:[\\/])/

/**
 * The half of a preflight check worth showing next to its name (SessionChips' status popover).
 *
 * Passing checks report an install location, and a resolved absolute path is the one detail
 * that tells a reader nothing they wanted: it is long enough to wrap the popover twice and it
 * only ever restates "found". Versions (`0.3.0`) and sub-tool lists (`find-navigator-errors,
 * …`) are kept — those are the reason a reader opened the popover. A detail that merely echoes
 * the check's own name goes too.
 *
 * Failing checks keep their detail unconditionally: that string is the pack's `fixHint`, and
 * for a missing binary the path IS the answer.
 *
 * Lives here rather than beside the component because a non-component export from a `.tsx`
 * breaks Fast Refresh for the whole file (react-refresh/only-export-components).
 */
export function checkDetail(check: { name: string; ok: boolean; detail: string }): string | null {
  if (!check.ok) return check.detail || null
  const detail = check.detail.trim()
  if (!detail || detail === check.name) return null
  return ABSOLUTE_PATH.test(detail) ? null : detail
}
