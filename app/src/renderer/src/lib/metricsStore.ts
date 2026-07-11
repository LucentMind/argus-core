import { useCallback, useEffect, useState } from 'react'
import type { GlobalMetrics, MetricsQuery, MetricsSummary } from '../../../shared/observability'

export function useGlobalMetrics(q?: MetricsQuery): {
  data: GlobalMetrics | null
  reload: () => void
} {
  const [data, setData] = useState<GlobalMetrics | null>(null)
  const since = q?.since
  const reload = useCallback((): void => {
    void window.argus.metrics.global(since ? { since } : undefined).then(setData)
  }, [since])
  useEffect(() => reload(), [reload])
  return { data, reload }
}

export function useCaseMetrics(slug: string): { data: MetricsSummary | null } {
  const [data, setData] = useState<MetricsSummary | null>(null)
  useEffect(() => {
    if (!slug) return
    let alive = true
    // Clear prior case's data immediately on scope switch so the view shows
    // loading, not the previous case's stale metrics.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset-on-scope-switch
    setData(null)
    void window.argus.metrics.case(slug).then((d) => {
      if (alive) setData(d)
    })
    return () => {
      alive = false // discard out-of-order / late resolutions
    }
  }, [slug])
  // Derive (not effect-set) so the empty-slug case never needs a synchronous
  // setState in the effect body, and so it can't ever show stale data.
  return { data: slug ? data : null }
}
