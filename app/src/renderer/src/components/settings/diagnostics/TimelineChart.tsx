import { useState } from 'react'
import type { DiagnosticsSeries } from '../../../../../shared/diagnostics'
import { niceMax, projectArea, projectSeries, seriesDenominator } from '../../../lib/timeline'

const VIEW_W = 600
const VIEW_H = 120

function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function TimelineChart({
  testId,
  title,
  series,
  kind,
  accent,
  bridge,
  from,
  bucketMs,
  format
}: {
  testId: string
  title: string
  series: DiagnosticsSeries
  kind: 'percent' | 'bytes'
  /** A theme custom-property NAME, e.g. '--signal'. Never a literal colour: the page is
   *  themed and both modes have separately-tuned values for these. */
  accent: string
  bridge: number
  from: number
  bucketMs: number
  format: (v: number) => string
}): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null)

  // `hover` is an index into `series`, but `series` is a prop whose length changes
  // whenever the timeline window changes (720 buckets at 1h, 60 at 5m). React preserves
  // component state across that prop change, so a hover index that was valid for the old,
  // longer series can point past the end of a new, shorter one. The pointer never has to
  // leave the SVG for this to happen — Tab-ing to a window button and pressing Enter
  // never fires onMouseLeave.
  //
  // Reset it during render rather than in a useEffect: an effect would let this render
  // commit with the stale, out-of-range index first and only fix it on the NEXT render,
  // whereas adjusting state while rendering (React's documented pattern for this — see
  // "you might not need an effect") throws this render away and redoes it immediately
  // with the corrected value, so nothing stale ever commits to the DOM.
  const [prevSeriesLength, setPrevSeriesLength] = useState(series.length)
  if (series.length !== prevSeriesLength) {
    setPrevSeriesLength(series.length)
    if (hover !== null && hover >= series.length) setHover(null)
  }

  const max = niceMax(series, kind)
  const projection = { width: VIEW_W, height: VIEW_H, max, bridge }
  const line = projectSeries(series, projection)
  const area = projectArea(series, projection)
  const denom = seriesDenominator(series.length)

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    // jsdom reports a zero-size rect, and a collapsed container can too. Without this
    // guard, rect.width === 0 makes the division yield Infinity, which the clamp below
    // would map to a wrong bucket (the last one) instead of failing safely. If clientX
    // also equals rect.left the division instead yields NaN — Math.min/Math.max
    // *propagate* NaN rather than clamp it, so that sub-case doesn't pick a wrong bucket
    // at all, it leaves hover state non-finite.
    if (!(rect.width > 0) || series.length === 0) return
    const i = Math.round(((e.clientX - rect.left) / rect.width) * denom)
    setHover(Math.min(Math.max(i, 0), series.length - 1))
  }

  // Belt-and-braces alongside the render-phase reset above: `series[hover] ?? null` makes
  // this lookup total so that even a hover index this component failed to catch cannot
  // smuggle `undefined` into `format()`, which would print the literal string
  // "NaN%"/"NaN GB" to a user-visible tooltip.
  const hovered = hover === null ? null : (series[hover] ?? null)

  return (
    <div className="p-3">
      {/* Labels are HTML, never SVG <text>: preserveAspectRatio="none" stretches the
          viewBox to the container and would distort any glyph inside it. */}
      <div className="flex items-baseline justify-between text-xs text-mute">
        <span>{title}</span>
        <span className="font-mono">{format(max)}</span>
      </div>
      <div className="relative mt-1">
        <svg
          data-testid={testId}
          data-buckets={series.length}
          data-empty={line === ''}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="h-[120px] w-full"
          role="img"
          aria-label={title}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {[0, 0.5, 1].map((f) => (
            <line
              key={f}
              x1={0}
              x2={VIEW_W}
              y1={VIEW_H * f}
              y2={VIEW_H * f}
              stroke="var(--hair)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {area !== '' && (
            <path d={area} fill={`var(${accent})`} fillOpacity={0.12} stroke="none" />
          )}
          {line !== '' && (
            <path
              d={line}
              fill="none"
              stroke={`var(${accent})`}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {hover !== null && (
            <line
              x1={(hover / denom) * VIEW_W}
              x2={(hover / denom) * VIEW_W}
              y1={0}
              y2={VIEW_H}
              stroke="var(--hair-2)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {hover !== null && (
          <div
            data-testid={`${testId}-tip`}
            className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-r2 border border-hair bg-overlay px-2 py-1 text-xs"
            style={{ left: `${(hover / denom) * 100}%` }}
          >
            <div className="font-mono">{hovered === null ? 'no sample' : format(hovered)}</div>
            <div className="text-mute">{clockLabel(from + hover * bucketMs)}</div>
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between text-xs text-mute">
        <span>{clockLabel(from)}</span>
        <span>{clockLabel(from + series.length * bucketMs)}</span>
      </div>
    </div>
  )
}
