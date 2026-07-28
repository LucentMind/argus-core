import { useEffect, useSyncExternalStore } from 'react'
import type { PrStatus } from '../../../shared/prStatus'

/**
 * The renderer's mirror of `pr_status_cache`. Every surface that shows a PR or CI state reads
 * here; only `refresh` reaches main, and only a mounted surface calls it (design decision 3).
 */

const EMPTY: Record<string, PrStatus> = {}

class PrStatusStore {
  private bySlug: Record<string, PrStatus> = EMPTY
  private listeners = new Set<() => void>()

  getAll(): Record<string, PrStatus> {
    return this.bySlug
  }

  get(slug: string): PrStatus | null {
    return this.bySlug[slug] ?? null
  }

  /** Seed from the DB cache. No network. */
  async load(slugs: string[]): Promise<void> {
    if (slugs.length === 0) return
    this.merge(await window.argus.pr.statusList(slugs))
  }

  /** Hit GitHub for these cases and adopt the result. */
  async refresh(slugs: string[]): Promise<void> {
    if (slugs.length === 0) return
    this.merge(await window.argus.pr.statusRefresh(slugs))
  }

  /** Test seam; also used to reset between cases in dev. */
  hydrate(map: Record<string, PrStatus>): void {
    this.bySlug = map
    this.emit()
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private merge(incoming: Record<string, PrStatus>): void {
    if (Object.keys(incoming).length === 0) return
    // A new object every merge: useSyncExternalStore compares snapshots by reference, so
    // mutating in place would render nothing.
    this.bySlug = { ...this.bySlug, ...incoming }
    this.emit()
  }

  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}

export const prStatusStore = new PrStatusStore()

/** Is any of these PRs still waiting on CI? The single condition that arms the poll. */
export function anyRunning(statuses: (PrStatus | null)[]): boolean {
  return statuses.some((s) => s?.rollup === 'running')
}

/**
 * Subscribe to these cases' statuses, seeding from cache and refreshing on mount, then polling
 * ONLY while some check is non-terminal.
 *
 * The interval is armed from the refresh result rather than from a `setInterval` that checks a
 * condition: a poll that has nothing left to watch should not exist, not merely no-op. It is
 * torn down on slug-list change and on unmount, so a case switch cannot leave a timer refreshing
 * a case nobody is looking at.
 */
export function usePrStatuses(slugs: string[], intervalMs: number): Record<string, PrStatus> {
  const all = useSyncExternalStore(
    (cb) => prStatusStore.subscribe(cb),
    () => prStatusStore.getAll()
  )
  // Depend on the CONTENT of the slug list, not the array identity — callers build it inline.
  // The effect rebuilds the list from this key rather than closing over `slugs`, so there is no
  // ref to keep in sync (the plan carried one; it was never read, and writing it during render
  // trips `react-hooks/refs`).
  const key = slugs.join(',')

  useEffect(() => {
    const list = key === '' ? [] : key.split(',')
    if (list.length === 0) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async (): Promise<void> => {
      try {
        await prStatusStore.refresh(list)
      } catch {
        // A failed refresh is not a reason to tear the app down or to keep polling: main
        // already caches an `unavailable` status when GitHub answered at all, and a rejection
        // here means the IPC itself failed. Stop and let the next mount or button try again.
        return
      }
      if (cancelled) return
      if (anyRunning(list.map((s) => prStatusStore.get(s)))) {
        timer = setTimeout(() => void tick(), intervalMs)
      }
    }

    void prStatusStore.load(list).then(() => {
      if (!cancelled) void tick()
    })

    const off = window.argus.pr.onStatusChanged((changed) => {
      if (!cancelled && changed.some((s) => list.includes(s))) void prStatusStore.load(list)
    })

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      off()
    }
  }, [key, intervalMs])

  return all
}
