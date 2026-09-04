import type { StripNode, StripState } from './runsModel'

const TONE: Record<StripState, string> = {
  done: 'border-hair text-ink',
  error: 'border-danger/60 text-danger',
  'not-reached': 'border-hair text-mute',
  running: 'border-signal/60 text-signal animate-pulse',
  pending: 'border-hair text-dim border-dashed',
  skipped: 'border-hair text-dim'
}

/** One node per stage in DAG order. `summary` and `candidates` are siblings (2a ‖ 2b) and render
 *  stacked between the same two arrows. */
export function PipelineStrip({
  nodes,
  onSelect
}: {
  nodes: StripNode[]
  onSelect: (id: string) => void
}): React.JSX.Element {
  const node = (n: StripNode): React.JSX.Element => (
    <button
      key={n.id}
      type="button"
      data-testid={`strip-${n.id}`}
      data-state={n.state}
      title={n.error ?? n.stat}
      onClick={() => onSelect(n.id)}
      className={`flex flex-col items-start rounded-r2 border px-2 py-1 text-left font-mono text-[11px] ${TONE[n.state]}`}
    >
      <span>{n.label}</span>
      <span className="text-[10px] text-dim">
        {n.state === 'not-reached' ? 'not reached' : n.stat}
      </span>
    </button>
  )
  const out: React.JSX.Element[] = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.id === 'summary' && nodes[i + 1]?.id === 'candidates') {
      out.push(
        <div key="2ab" className="flex flex-col gap-1">
          {node(n)}
          {node(nodes[i + 1])}
        </div>
      )
      i++
    } else out.push(node(n))
    if (i < nodes.length - 1)
      out.push(
        <span key={`arrow-${i}`} className="text-mute">
          →
        </span>
      )
  }
  return <div className="flex flex-wrap items-center gap-1.5">{out}</div>
}
