import { useEffect, useState } from 'react'
import type { DistillJobRow } from '../../../shared/distill'

/** Subscribes to a case's distillation job. Extracted from DistillChip so the case-actions
 *  menu can label its Re-distill row with the same state the chip used to occupy bar width
 *  to show. */
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
      if (p.caseSlug === slug) setJob(p.job)
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
