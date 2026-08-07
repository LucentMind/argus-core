import type { DiagnosticsSeries } from '../../../../../shared/diagnostics'
import { projectSeries } from '../../../lib/timeline'

const W = 72
const H = 18

/**
 * A micro-chart for one table row: shape at a glance, nothing else.
 *
 * Deliberately has no hover layer, unlike TimelineChart. The row already prints the live
 * value beside this mark, and N tooltips in a dense table is noise rather than
 * information. See the spec §5.7 — this is a recorded decision, not an omission.
 */
export function Sparkline({
  series,
  max,
  bridge,
  label
}: {
  series: DiagnosticsSeries
  max: number
  bridge: number
  label: string
}): React.JSX.Element {
  const d = projectSeries(series, { width: W, height: H, max, bridge })
  return (
    <svg
      data-testid="diag-sparkline"
      data-empty={d === ''}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-[18px] w-[72px] overflow-visible"
      role="img"
      aria-label={label}
    >
      {d !== '' && (
        <path
          d={d}
          fill="none"
          stroke="var(--signal)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  )
}
