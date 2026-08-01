import { useEffect, useSyncExternalStore } from 'react'
import type { PrStatus } from '../../../shared/prStatus'

/**
 * The renderer's mirror of `pr_status_cache`. Every surface that shows a PR or CI state reads
 * here; only `refresh` reaches main, and only a mounted surface calls it (design decision 3).
 */

const EMPTY: Record<string, PrStatus> = {}

class PrStatusStore {
  private bySlug: Record<string, PrStatus> = EMPTY
  private loadedSlugs = new Set<string>()
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
    try {
      this.merge(await window.argus.pr.statusList(slugs))
    } finally {
      // Marked even on rejection: a surface that stays skeletal forever after one transient
      // IPC blip is worse than one that shows its empty state.
      for (const s of slugs) this.loadedSlugs.add(s)
      this.emit()
    }
  }

  /** Hit GitHub for these cases and adopt the result. */
  async refresh(slugs: string[]): Promise<void> {
    if (slugs.length === 0) return
    this.merge(await window.argus.pr.statusRefresh(slugs))
  }

  /**
   * Has this slug's cache read settled? Not inferable from `bySlug`: a case with no bound PR is
   * never cached, so absence means both "not fetched yet" and "nothing to fetch".
   *
   * Deliberately NOT cleared by `forget()` — after an unlink we know there is no PR, and the
   * empty state should appear immediately rather than flashing a skeleton first.
   */
  isLoaded(slug: string): boolean {
    return this.loadedSlugs.has(slug)
  }

  /** Test seam; also used to reset between cases in dev. */
  hydrate(map: Record<string, PrStatus>): void {
    this.bySlug = map
    this.loadedSlugs = new Set(Object.keys(map))
    this.emit()
  }

  /** Drop a slug outright. Unlink is the one transition refresh() cannot express: a case with
   *  no binding is skipped by the service rather than cached empty, so nothing would overwrite
   *  the stale entry. */
  forget(slug: string): void {
    if (!(slug in this.bySlug)) return
    const rest = { ...this.bySlug }
    delete rest[slug]
    this.bySlug = rest
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

/**
 * Is any of these PRs still waiting on CI? The single condition that arms the fast poll.
 *
 * Reads the checks rather than the rollup: a pull request with one red check reports `failing`
 * (or `unstable`) while a dozen jobs are still running, and keying off the dot would drop to
 * the idle cadence exactly when the state is changing fastest. Wherever a `running` rollup
 * exists at all it implies a pending check, so this is strictly the same condition plus the
 * cases the dot was hiding.
 */
export function anyRunning(statuses: (PrStatus | null)[]): boolean {
  return statuses.some((s) => s?.checks.some((c) => c.bucket === 'pending') ?? false)
}

/**
 * How much slower to poll once every check has settled.
 *
 * The poll used to stop outright at all-terminal, which was circular: a PR going terminal →
 * running again (you push a fix, CI restarts) could never be discovered, because discovering it
 * needed the poll that had just been switched off. Measured 2026-07-28 with the dashboard open
 * throughout — a commit was pushed, CI ran for four minutes and finished, and the surface never
 * looked once; it was still showing a ten-minute-old "passing" while GitHub said "running".
 *
 * So the poll now idles instead of stopping: 20s → 60s in review mode, 60s → 180s on the
 * dashboard. A multiplier rather than a fixed idle interval, so the two surfaces keep their
 * relative cadence and a caller that changes `intervalMs` does not have to change this too.
 */
export const IDLE_POLL_MULTIPLIER = 3

/**
 * How long to wait after the window comes back before refreshing.
 *
 * Sized to coalesce events, not to rate-limit the user: restoring a minimised window fires
 * `focus` AND `visibilitychange`, and one user action must cost one fetch. Shorter risks two
 * fetches for one restore; longer is perceptible as staleness on return.
 */
export const RETURN_REFRESH_DEBOUNCE_MS = 1000

/**
 * Subscribe to these cases' statuses, seeding from cache and refreshing on mount, then polling —
 * quickly while some check is non-terminal, slowly once they have all settled.
 *
 * The interval is armed from the refresh result rather than from a `setInterval` that checks a
 * condition, so the cadence always reflects the state that was actually observed. It is torn
 * down on slug-list change and on unmount, so a case switch cannot leave a timer refreshing a
 * case nobody is looking at — that teardown, not a stop condition, is what bounds the poll.
 *
 * The chain is additionally gated on whether anyone can SEE the window. Hidden suspends it
 * outright; coming back refreshes once and resumes. Losing focus while still visible does
 * nothing — a dashboard open on a second monitor is being read, and gating it on focus would
 * freeze exactly the surface whose whole job is to stay current.
 *
 * Suspending is a full stop rather than a slowdown on purpose: Chromium already throttles timers
 * in a hidden page to roughly 1/min (Electron's `backgroundThrottling` defaults to true and is
 * not overridden), so a second, weaker slowdown layered on top would be one more state to reason
 * about for no gain. The win here is less the saved ticks than the refresh on return: without it
 * a restored dashboard shows data up to `intervalMs * IDLE_POLL_MULTIPLIER` old and has no way to
 * hurry the next one.
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
    // Distinct from `cancelled`, which means torn down. This mount is still live and WILL resume,
    // so the two cannot share a flag: `cancelled` is checked to abandon work, `suspended` to
    // withhold the next arming.
    let suspended = document.visibilityState === 'hidden'
    let timer: ReturnType<typeof setTimeout> | null = null
    let debounce: ReturnType<typeof setTimeout> | null = null

    const clearPoll = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }

    const tick = async (): Promise<void> => {
      let failed = false
      try {
        await prStatusStore.refresh(list)
      } catch {
        // A rejection here means the IPC itself failed (main already caches `unavailable`
        // whenever GitHub answered at all). It re-arms at the idle cadence rather than
        // returning: a surface that goes permanently blind after one transient blip is the
        // same defect as stopping at all-terminal, just with a rarer trigger.
        failed = true
      }
      // A tick already in flight when the window hid is allowed to settle — its result is still
      // worth adopting — but must not re-arm, or suspension would last exactly one interval.
      if (cancelled || suspended) return
      const running = !failed && anyRunning(list.map((s) => prStatusStore.get(s)))
      timer = setTimeout(
        () => void tick(),
        running ? intervalMs : intervalMs * IDLE_POLL_MULTIPLIER
      )
    }

    void prStatusStore.load(list).then(() => {
      if (!cancelled && !suspended) void tick()
    })

    const suspend = (): void => {
      suspended = true
      clearPoll()
      if (debounce) {
        clearTimeout(debounce)
        debounce = null
      }
    }

    /** Idempotent by construction: re-entry restarts the debounce rather than stacking fetches. */
    const resume = (): void => {
      if (cancelled) return
      suspended = false
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = null
        if (cancelled || suspended) return
        // Supersede any tick still armed from before the window went away, so returning cannot
        // leave two chains running.
        clearPoll()
        void tick()
      }, RETURN_REFRESH_DEBOUNCE_MS)
    }

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') suspend()
      else resume()
    }

    document.addEventListener('visibilitychange', onVisibility)
    // `focus` does not bubble, so this fires for the window itself and not for focusing an input.
    // It covers the transition `visibilitychange` misses: alt-tabbing back to a window that was
    // never hidden, only unfocused.
    window.addEventListener('focus', resume)

    const off = window.argus.pr.onStatusChanged((changed) => {
      if (!cancelled && changed.some((s) => list.includes(s))) void prStatusStore.load(list)
    })

    return () => {
      cancelled = true
      clearPoll()
      if (debounce) clearTimeout(debounce)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', resume)
      off()
    }
  }, [key, intervalMs])

  return all
}
