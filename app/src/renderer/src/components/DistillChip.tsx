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
  const [cancelling, setCancelling] = useState(false)
  // adjust-state-during-render: any broadcast (tracked) supersedes the optimistic retry
  // result, restoring the pre-split single-state semantics (see JiraSection's prevSyncedAt /
  // SessionSwitcher's lastOpen for the same idiom).
  const [prevTracked, setPrevTracked] = useState(tracked)
  if (tracked !== prevTracked) {
    setPrevTracked(tracked)
    setOverride(null)
    setCancelling(false)
  }
  const job = override ?? tracked

  if (!job) return null

  if (job.state === 'queued' || job.state === 'running') {
    // The chip is the only place the run is visible from outside the menu, so it is also the
    // fastest place to stop it. `cancelling…` is local and optimistic, cleared as soon as
    // `cancel()`'s own response comes back — same idiom as `retry` below — rather than
    // depending on the main-process broadcast, which `DistillQueue.emit()` swallows failures
    // from. `cancel()` persists the terminal `cancelled` state synchronously before returning,
    // so the resolved row is already correct to adopt directly via `setOverride`.
    //
    // The handler stays present (a no-op) rather than becoming `undefined` while cancelling:
    // `Chip` renders a plain `<span>` without a handler, which would swap out the `<button>`
    // mid-interaction and drop both focus and its accessible button role.
    return (
      <Chip
        onClick={
          cancelling
            ? () => undefined
            : () => {
                setCancelling(true)
                void window.argus.distill
                  .cancel(job.id)
                  .then(setOverride)
                  .catch(() => setCancelling(false))
              }
        }
        title={cancelling ? 'Cancelling…' : 'Cancel distillation'}
        aria-label={cancelling ? 'Cancelling distillation' : 'Cancel distillation'}
      >
        {cancelling ? 'cancelling…' : 'distilling… ✕'}
      </Chip>
    )
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
