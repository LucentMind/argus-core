import type { RelatedSourceInfo, SourceHealth } from '../../../../shared/relatedHistory'
import type { ExplorerRequest } from './RelatedHistoryExplorer'

export function ExplorerFilters({
  sources
}: {
  req: ExplorerRequest
  sources: RelatedSourceInfo[]
  health: SourceHealth[]
  onChange: (patch: Partial<ExplorerRequest>) => void
  onRetry: () => void
}): React.JSX.Element {
  return (
    <aside className="flex w-52 shrink-0 flex-col gap-3 overflow-y-auto pr-2 text-xs">
      {sources.map((s) => (
        <div key={s.id} className="text-dim">
          {s.name}
        </div>
      ))}
    </aside>
  )
}
