import { useLayoutEffect, useRef, useState } from 'react'
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
  // Bumped whenever `tracked` changes identity, so an in-flight cancel response can tell
  // whether a broadcast has superseded it since the click (see the cancel handler below).
  // `react-hooks/refs` forbids touching a ref's `.current` directly in the render body (the
  // block above), so this lives in an effect instead — specifically a *layout* effect, not a
  // plain one: layout effects flush synchronously during commit, in the same synchronous turn
  // as the `setJob` call that changed `tracked` (see useDistillJob's `onChanged` callback), so
  // the bump is guaranteed to land before the JS engine ever gets to the microtask queue where
  // a pending `cancel()` promise's `.then()` is waiting. A plain `useEffect` is scheduled later
  // and could lose that race. This is not the mount/unmount `ref.current = false` cleanup shape
  // that breaks under StrictMode — it fires on every commit where `tracked` changed, mirroring
  // (not replacing) the render-time reset above, and repeated bumps are harmless since callers
  // only ever check `===` against a snapshot, never the exact count.
  const cancelEpochRef = useRef(0)
  useLayoutEffect(() => {
    cancelEpochRef.current += 1
  }, [tracked])
  const job = override ?? tracked

  if (!job) return null

  if (job.state === 'queued' || job.state === 'running') {
    // The chip is the only place the run is visible from outside the menu, so it is also the
    // fastest place to stop it. `cancelling…` is local and optimistic, cleared as soon as
    // `cancel()`'s own response comes back — same idiom as `retry` below — rather than
    // depending on the main-process broadcast, which `DistillQueue.emit()` swallows failures
    // from. `cancel()` persists the terminal `cancelled` state synchronously before returning,
    // so the resolved row is correct to adopt directly via `setOverride` — but only if nothing
    // has superseded it since the click: if a broadcast for a newer job on this slug lands
    // first, the adjust-during-render block above already reset `override`/`cancelling` and
    // bumped `cancelEpochRef`, and adopting this now-stale `cancelled` row for the old job would
    // overwrite the newer job's row with one that matches no render branch, hiding its chip.
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
                const epoch = cancelEpochRef.current
                void window.argus.distill
                  .cancel(job.id)
                  .then((row) => {
                    if (cancelEpochRef.current === epoch) setOverride(row)
                  })
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
