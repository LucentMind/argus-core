import { useEffect, useState } from 'react'
import type { DistillationUsageStats } from '../../../../shared/observability'
import { StatCard, usd } from './MetricCards'

/**
 * Distillation spend + run counts, as a card group on the global Observability dashboard.
 *
 * Moved here from the Distillation settings section (user-directed, 2026-09-04) — spend belongs
 * beside the app's other cost/usage metrics, not on the page that configures which provider runs
 * distillation. Renders nothing (not even the section heading) when no run has ever happened,
 * matching the settings row's old "absent, not zero" behavior.
 */
export function DistillationCards({
  since,
  hiddenCards,
  onOpenRuns
}: {
  since?: string
  hiddenCards: readonly string[]
  onOpenRuns?: () => void
}): React.JSX.Element | null {
  const [d, setD] = useState<DistillationUsageStats | null>(null)
  useEffect(() => {
    let live = true
    void window.argus.usage
      .stats(since ? { since } : undefined)
      .then((u) => live && setD(u.distillation))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [since])
  if (!d || d.jobCount + d.dryRunCount === 0) return null
  const hidden = (id: string): boolean => hiddenCards.includes(id)
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xs uppercase tracking-wide text-dim">Distillation</h2>
        {onOpenRuns && (
          <button
            type="button"
            className="text-xs text-dim underline decoration-dotted hover:text-ink"
            onClick={onOpenRuns}
          >
            Open runs
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {!hidden('distill.runs') && (
          <StatCard
            id="distill.runs"
            label="Distillation runs"
            value={String(d.jobCount)}
            sub={`${d.failedCount} failed`}
          />
        )}
        {!hidden('distill.spend') && (
          <StatCard
            id="distill.spend"
            label="Distillation spend"
            value={usd(d.totalCostUsd)}
            sub={d.avgCostUsd !== null ? `avg ${usd(d.avgCostUsd)} / run` : undefined}
          />
        )}
        {!hidden('distill.failedSpend') && (
          <StatCard
            id="distill.failedSpend"
            label="Failed-run spend"
            value={usd(d.failedCostUsd)}
          />
        )}
        {!hidden('distill.drySpend') && (
          <StatCard
            id="distill.drySpend"
            label="Dry-run spend"
            value={usd(d.dryRunCostUsd)}
            sub={`${d.dryRunCount} dry run${d.dryRunCount === 1 ? '' : 's'}`}
          />
        )}
      </div>
    </section>
  )
}
