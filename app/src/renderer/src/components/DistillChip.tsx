import { useState } from 'react'
import type { DistillJobRow } from '../../../shared/distill'
import { Chip } from './ui'
import { useDistillJob } from '../lib/distillJob'

/**
 * Distillation, but only while it needs the bar's attention. The resting `done` states
 * moved to the Re-distill menu row (`distillMenuLabel`) — they persist for the life of the
 * case, so as chips they were permanent furniture in a bar with no room for it.
 */
export function DistillChip({ slug }: { slug: string }): React.JSX.Element | null {
  const tracked = useDistillJob(slug)
  const [override, setOverride] = useState<DistillJobRow | null>(null)
  const [retrying, setRetrying] = useState(false)
  // adjust-state-during-render: any broadcast (tracked) supersedes the optimistic retry
  // result, restoring the pre-split single-state semantics (see JiraSection's prevSyncedAt /
  // SessionSwitcher's lastOpen for the same idiom).
  const [prevTracked, setPrevTracked] = useState(tracked)
  if (tracked !== prevTracked) {
    setPrevTracked(tracked)
    setOverride(null)
  }
  const job = override ?? tracked

  if (!job) return null

  if (job.state === 'queued' || job.state === 'running') {
    return <Chip>distilling…</Chip>
  }

  if (job.state === 'failed') {
    return (
      <button
        className="font-mono text-[10.5px] uppercase tracking-wide text-danger"
        disabled={retrying}
        onClick={() => {
          setRetrying(true)
          void window.argus.distill
            .retry(job.id)
            .then(setOverride)
            .catch(() =>
              window.argus.distill
                .status(slug)
                .then((j) => j && setOverride(j))
                .catch(() => undefined)
            )
            .finally(() => setRetrying(false))
        }}
      >
        distill failed — retry
      </button>
    )
  }

  return null
}
