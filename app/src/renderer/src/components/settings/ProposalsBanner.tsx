import { useProposalCounts } from '../../lib/proposalsStore'
import type { ProposalType } from '../../../../shared/proposals'

/** Slim per-page hint that pending proposals touch this page's asset kind. */
export function ProposalsBanner({
  types,
  noun,
  onReview
}: {
  types: readonly ProposalType[]
  noun: string
  onReview: () => void
}): React.JSX.Element | null {
  const counts = useProposalCounts()
  const n = types.reduce((acc, t) => acc + (counts?.byType[t] ?? 0), 0)
  if (n === 0) return null
  return (
    <div className="flex items-center gap-2 rounded-r2 border border-review/40 bg-review/10 px-3 py-2 text-xs text-ink">
      <span className="flex-1">
        {n} pending proposal{n === 1 ? '' : 's'} touch{n === 1 ? 'es' : ''} {noun}.
      </span>
      <button className="underline transition-colors hover:text-signal" onClick={onReview}>
        Review →
      </button>
    </div>
  )
}
