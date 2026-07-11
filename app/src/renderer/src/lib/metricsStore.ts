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
    void window.argus.metrics.case(slug).then(setData)
  }, [slug])
  return { data }
}
