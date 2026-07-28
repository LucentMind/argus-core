import type { DatabaseSync } from 'node:sqlite'
import type { PrStatus } from '../../shared/prStatus'
import type { PrBinding } from '../../shared/pr'
import { defaultGhRunner, fetchPrStatuses, prTargetKey, type PrTarget, type Runner } from './github'
import { getBinding } from './prBindings'
import { writePrStatus, readPrStatuses } from './prStatusCache'

export interface PrStatusDeps {
  db: DatabaseSync
  /** Injected in tests; production passes nothing and gets the default gh runner. */
  gh?: Runner
  /** Injected in tests so `fetchedAt` is deterministic. */
  now?: () => string
}

/**
 * Refresh the given cases' PR/CI state in one round trip and cache each result.
 *
 * The ONLY writer of `pr_status_cache`. Two callers share it and must not drift: the dashboard
 * (every bound case) and review mode (the one bound case) — the difference is the slug list, not
 * the code path (design decision 3).
 *
 * A case with no binding is skipped rather than cached empty: `readPrStatuses` omitting it is
 * how every consumer already says "no PR here". A case whose fetch failed IS cached, as
 * `unavailable`, so a PR that was deleted or lost access overwrites its last-known green
 * instead of quietly keeping it (design decision 5).
 */
export async function refreshPrStatuses(
  deps: PrStatusDeps,
  caseSlugs: string[]
): Promise<Record<string, PrStatus>> {
  const bound: { slug: string; target: PrTarget }[] = []
  for (const slug of caseSlugs) {
    let b: PrBinding | null = null
    try {
      b = getBinding(deps.db, slug)
    } catch {
      continue // unknown slug — nothing to refresh, and not this function's error to raise
    }
    if (b) bound.push({ slug, target: { owner: b.owner, repo: b.repo, number: b.number } })
  }
  if (bound.length === 0) return {}

  const now = (deps.now ?? ((): string => new Date().toISOString()))()
  const byKey = await fetchPrStatuses(
    deps.gh ?? defaultGhRunner,
    bound.map((b) => b.target),
    now
  )

  const out: Record<string, PrStatus> = {}
  for (const { slug, target } of bound) {
    const status = byKey.get(prTargetKey(target))
    if (!status) continue // fetchPrStatuses never omits a target; belt-and-braces
    writePrStatus(deps.db, slug, status)
    out[slug] = status
  }
  return out
}

/** Cached statuses with no fetch. Re-exported so callers need only this module. */
export { readPrStatuses }
