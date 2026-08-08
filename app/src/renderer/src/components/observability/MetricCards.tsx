import { Skeleton } from '../ui'

export function StatCard({
  label,
  value,
  sub,
  id
}: {
  label: string
  value: string
  sub?: string
  /** Stable identifier matched against `observability.dashboard.hiddenCards` for visibility filtering. */
  id?: string
}): React.JSX.Element {
  return (
    <div data-card-id={id} className="flex flex-col gap-1 rounded-r2 surface-card p-4">
      <span className="text-xs uppercase tracking-wide text-dim">{label}</span>
      <span className="text-2xl font-semibold text-ink">{value}</span>
      {sub && <span className="text-xs text-mute">{sub}</span>}
    </div>
  )
}

/**
 * The stat grid before its metrics arrive (user-directed, 2026-08-08) — replaces the
 * "Loading metrics…" line the dashboard used to print in its place.
 *
 * Cards, not bars: what lands here is a 4-across grid of `StatCard`s, and reserving that grid
 * means the page does not lurch from one text line to four rows of tiles. Each tile mirrors
 * StatCard's own box (`surface-card p-4`, label over value) so the swap is a fill, not a
 * relayout.
 */
export function StatCardsSkeleton({ count = 8 }: { count?: number }): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label="Loading metrics"
      className="grid grid-cols-2 gap-3 md:grid-cols-4"
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-r2 surface-card p-4">
          <Skeleton className="h-2.5 w-[55%]" />
          <Skeleton className="h-5 w-[40%]" />
        </div>
      ))}
    </div>
  )
}

// Plain formatting helpers, not components — co-located with StatCard since
// both are tiny and only used by ObservabilityView. Fast refresh only reloads
// this file's components on edit; harmless for such small pure helpers.
// eslint-disable-next-line react-refresh/only-export-components
export function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${Math.round((n / d) * 100)}%`
}

// eslint-disable-next-line react-refresh/only-export-components
export function usd(n: number | null): string {
  return n == null ? '—' : `$${n.toFixed(2)}`
}
