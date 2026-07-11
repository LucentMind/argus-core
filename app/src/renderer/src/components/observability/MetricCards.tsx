export function StatCard({
  label,
  value,
  sub
}: {
  label: string
  value: string
  sub?: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-r2 border border-hair bg-deep p-4">
      <span className="text-xs uppercase tracking-wide text-dim">{label}</span>
      <span className="text-2xl font-semibold text-ink">{value}</span>
      {sub && <span className="text-xs text-mute">{sub}</span>}
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
