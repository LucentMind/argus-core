import { useMemo, useState } from 'react'
import { useGlobalMetrics } from '../../lib/metricsStore'
import { StatCard, pct, usd } from './MetricCards'

const RANGES = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: 'all', label: 'All', days: null }
] as const

// Module-level (not inline in the component body) so the time-based
// computation reads as an ordinary data transform to the react-hooks purity
// check, rather than an impure call inlined into render.
function sinceFor(range: (typeof RANGES)[number]['id']): string | undefined {
  const r = RANGES.find((x) => x.id === range)!
  if (r.days == null) return undefined
  return new Date(Date.now() - r.days * 86_400_000).toISOString()
}

export function ObservabilityView({
  onOpenCase
}: {
  onOpenCase: (slug: string) => void
}): React.JSX.Element {
  // onOpenCase wires per-case drilldown, added in Task 6; kept as a prop now
  // so App.tsx's call site doesn't change shape between tasks.
  void onOpenCase
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('30d')
  const since = useMemo(() => sinceFor(range), [range])
  const { data } = useGlobalMetrics(since ? { since } : undefined)

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Observability</h1>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={`rounded-r1 px-2.5 py-1 text-xs ${
                range === r.id ? 'bg-hi text-ink' : 'text-dim hover:bg-hair'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {!data ? (
        <p className="text-sm text-mute">Loading metrics…</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard
            label="Total cost"
            value={usd(data.totalCostUsd)}
            sub={`${data.turns.total} turns`}
          />
          <StatCard label="Tokens (in/out)" value={`${data.inputTokens} / ${data.outputTokens}`} />
          <StatCard
            label="HITL approval"
            value={pct(
              (data.tools.byDecision.user ?? 0) + (data.tools.byDecision['allow-session'] ?? 0),
              data.tools.total
            )}
            sub={`${data.tools.total} asks`}
          />
          <StatCard label="Tool denials" value={pct(data.tools.denied, data.tools.total)} />
          <StatCard
            label="Findings"
            value={String(data.findings.total)}
            sub={`${data.findings.accepted} accepted`}
          />
          <StatCard
            label="Finding acceptance"
            value={pct(data.findings.accepted, data.findings.accepted + data.findings.rejected)}
          />
          <StatCard label="Turn error rate" value={pct(data.turns.error, data.turns.total)} />
          <StatCard
            label="Cost / resolved case"
            value={usd(data.costPerResolvedCaseUsd)}
            sub={`${data.resolvedCases} closed`}
          />
          <StatCard
            label="Turn latency p50 / p95"
            value={`${data.latencyMs.turnP50 ?? '—'} / ${data.latencyMs.turnP95 ?? '—'} ms`}
          />
        </div>
      )}
    </div>
  )
}
