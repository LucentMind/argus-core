/**
 * Which items a scoped run will process, and which carry to the next one.
 *
 * PURE. No database, no network, no clock — callers hand in what they already read. That is what
 * makes the two rules this module owns (the cap and the cursor boundary) testable at all, and
 * both of them fail silently in production if they are wrong.
 *
 * Electron-free like the rest of services/routines/, and DB-free on top of that.
 */

/** One item as the scope resolver found it. `cursorValue` is the field the cursor tracks. */
export interface ResolvedItem {
  key: string
  cursorValue: string
}

/** One case as a `cases` scope found it, with this routine's last look at it. */
export interface CaseCandidate {
  slug: string
  updatedAt: string
  /** When this routine last opened an item row for this case; null = never. */
  lastAttemptAt: string | null
}

export interface Selection<T> {
  selected: T[]
  /** How many eligible items did NOT fit under the cap. Reported, never silently dropped. */
  deferred: number
}

function cap<T>(eligible: T[], maxItems: number): Selection<T> {
  return {
    selected: eligible.slice(0, maxItems),
    deferred: Math.max(0, eligible.length - maxItems)
  }
}

/**
 * JQL items, minus everything this routine has already attempted.
 *
 * THE EXCLUSION IS BY KEY, AND IT IS LOAD-BEARING. The query that produced `resolved` uses
 * `<cursorField> >= <cursor>`, inclusive, because Jira timestamps are not unique: two tickets
 * created in the same minute share a `created` value, and a strict `>` would advance past both
 * after attempting one, dropping the other permanently and silently. Inclusive means the last
 * item of the previous run always comes back, so something has to remove it — and the only thing
 * that identifies it exactly is its key.
 *
 * Attempted items are filtered BEFORE the cap, so a run whose window is full of already-seen
 * keys still does a full run's worth of new work.
 */
export function selectJqlItems(
  resolved: ResolvedItem[],
  attempted: ReadonlySet<string>,
  maxItems: number
): Selection<ResolvedItem> {
  return cap(
    resolved.filter((i) => !attempted.has(i.key)),
    maxItems
  )
}

/**
 * Cases this routine should look at again.
 *
 * NO CURSOR, deliberately. A monotonic timestamp cursor is *wrong* here, not merely unnecessary:
 * a stale-case sweep must revisit cases it has already seen, and a forward-only cursor would
 * visit each case once and never again — the opposite of a sweep. The predicate below needs no
 * persisted state at all.
 *
 * Strictly-greater on purpose: a case looked at in the same instant it was modified has already
 * been handled by that look, and `>=` would make every such case re-select forever.
 */
export function selectCaseItems(
  candidates: CaseCandidate[],
  maxItems: number
): Selection<CaseCandidate> {
  return cap(
    candidates.filter((c) => c.lastAttemptAt === null || c.updatedAt > c.lastAttemptAt),
    maxItems
  )
}
