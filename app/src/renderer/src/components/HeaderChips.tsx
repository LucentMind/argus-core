import { useSyncExternalStore } from 'react'
import { Chip } from './ui'
import { prStatusStore } from '../lib/prStatusStore'
import { PrRollupDot } from './PrRollupDot'

/**
 * The case's bound pull request — the one thing in this cluster that is a fact about the
 * *case* rather than about the chat. Readiness and cost moved to `SessionChips` in the
 * chat panel, where their subject actually lives.
 *
 * Read-only: the chip never fetches. The cache outlives review mode, so a case shows its
 * last known PR state in any mode — which is the point of putting it in the header rather
 * than in the review-only companion.
 */
export function HeaderChips({ slug }: { slug: string }): React.JSX.Element | null {
  const prStatus = useSyncExternalStore(
    (cb) => prStatusStore.subscribe(cb),
    () => prStatusStore.get(slug)
  )
  if (!prStatus) return null
  return (
    <Chip>
      <a
        href={prStatus.url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1"
        title={`${prStatus.owner}/${prStatus.repo}#${prStatus.number}`}
      >
        <PrRollupDot rollup={prStatus.rollup} size={6} />#{prStatus.number}
      </a>
    </Chip>
  )
}
