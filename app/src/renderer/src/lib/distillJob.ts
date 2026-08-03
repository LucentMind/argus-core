import { useEffect, useState } from 'react'
import type { DistillJobRow } from '../../../shared/distill'

/** Subscribes to a case's distillation job. Extracted from DistillChip so the case-actions
 *  menu can label its Re-distill row with the same state the chip used to occupy bar width
 *  to show.
 *
 *  Broadcasts for the same slug are not guaranteed to arrive in id order: `DistillQueue.enqueue`
 *  emits the NEW job first, then cancels every other in-flight row for the slug (each cancel()
 *  emits too) — probe-verified synchronous order for a running slug is `["2:queued",
 *  "1:cancelled"]`. An unconditional last-write-wins reducer would adopt that trailing broadcast
 *  for job 1 and end up tracking the OLD cancelled job instead of the fresh one that is actually
 *  queued/running, hiding it from every reader of this hook (the case menu, the bar chip) until
 *  job 2's own next state change happens to broadcast again. Guard by id instead: a broadcast
 *  whose job id is lower than the currently tracked job's id is stale and ignored; anything is
 *  adopted when nothing is tracked yet; a `null` payload always clears (it carries no id to
 *  compare, and null itself can never be "stale" — there is nothing after it to protect). */
export function useDistillJob(slug: string): DistillJobRow | null {
  const [job, setJob] = useState<DistillJobRow | null>(null)

  useEffect(() => {
    let mounted = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setJob(null)
    void window.argus.distill
      .status(slug)
      .then((j) => {
        if (mounted) setJob(j)
      })
      .catch(() => {
        if (mounted) setJob(null)
      })
    const off = window.argus.distill.onChanged((p) => {
      if (p.caseSlug !== slug) return
      setJob((current) => {
        if (p.job === null || current === null || p.job.id >= current.id) return p.job
        return current
      })
    })
    return () => {
      mounted = false
      off()
    }
  }, [slug])

  return job
}

/** True while the job still has work to stop — the states the Cancel affordance exists for. */
export function isDistillInFlight(job: DistillJobRow | null): boolean {
  return job?.state === 'queued' || job?.state === 'running'
}

/**
 * The distill menu row's label. It carries three jobs at once: the verb (first run vs re-run),
 * the in-flight escape hatch, and the resting readout of the last run. Only `done` states show a
 * count — `done` persists for the life of the case, so as a bar chip it was permanent furniture.
 * Running and failed stay on the bar (see DistillChip): one is genuinely transient, the other
 * needs to be loud.
 */
export function distillMenuLabel(job: DistillJobRow | null): string {
  if (isDistillInFlight(job)) return 'Cancel distillation'
  if (!job) return 'Distill'
  if (job.state !== 'done') return 'Re-distill'
  return job.itemCount && job.itemCount > 0
    ? `Re-distill · ${job.itemCount} items`
    : 'Re-distill · nothing to distill'
}
