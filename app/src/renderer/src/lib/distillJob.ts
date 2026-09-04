import { useEffect, useRef, useState } from 'react'
import type { DistillJobRow, DistillProgress } from '../../../shared/distill'

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
 *  compare, and null itself can never be "stale" — there is nothing after it to protect).
 *
 *  `DistillQueue.emit()` broadcasts every case-job state transition with no `dry_run` filter —
 *  only the DB read paths (`statusFor`, `needsDistillRun`, `evalExport`, `usage.distillationStats`)
 *  are blind to dry rows. Left unhandled, a dry run's own broadcasts would flow straight through
 *  the id guard above and get adopted here like any other job, so this hook would end up
 *  tracking a comparison run as if it were the case's real distillation state — including after
 *  the dry run FINISHES, at which point there is no further broadcast to correct it; the stale
 *  dry row would sit here until the component remounts. A dry run must still show and be
 *  cancellable while it's actually running (the chip is the only place to stop it), so an
 *  in-flight (`queued`/`running`) dry broadcast is adopted exactly like a real one via the id
 *  guard below. Only once a TRACKED dry row reaches a terminal state (`done`/`failed`/
 *  `cancelled`) does this hook special-case it: instead of adopting that broadcast's payload,
 *  it re-fetches `status(slug)`, which goes through `statusFor` and therefore returns the case's
 *  real job (or null) — reusing the existing DB-side filter rather than duplicating its logic
 *  here. That re-fetched real job's id is typically LOWER than the dry row that just finished
 *  (a dry run is enqueued against an already-distilled case), so this deliberately bypasses the
 *  id guard: adopting p.job first and THEN correcting would let the guard reject the correction
 *  as stale. `trackedRef` mirrors `job` so the guard and the terminal-dry check can read the
 *  current tracked job synchronously from inside the broadcast handler, the same idiom
 *  `useEscapeLayer` uses for its keep-fresh ref — written only from effects/handlers, never
 *  render, so `react-hooks/refs` has nothing to flag. The re-fetch's own `.then()` only adopts
 *  its result if `trackedRef` still matches whatever it held right before the terminal broadcast
 *  fired: if a newer broadcast (a fresh distill actually superseding the dry run) lands first,
 *  that already moved `trackedRef` on, and this stale re-fetch must not clobber it. */
export function useDistillJob(slug: string): DistillJobRow | null {
  const [job, setJob] = useState<DistillJobRow | null>(null)
  const trackedRef = useRef<DistillJobRow | null>(null)

  useEffect(() => {
    let mounted = true
    trackedRef.current = null
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setJob(null)
    void window.argus.distill
      .status(slug)
      .then((j) => {
        if (mounted) {
          trackedRef.current = j
          setJob(j)
        }
      })
      .catch(() => {
        if (mounted) {
          trackedRef.current = null
          setJob(null)
        }
      })
    const off = window.argus.distill.onChanged((p) => {
      if (p.caseSlug !== slug) return
      const current = trackedRef.current
      const stale = !(p.job === null || current === null || p.job.id >= current.id)
      if (stale) return

      if (p.job !== null && p.job.dryRun && !isDistillInFlight(p.job)) {
        // Snapshot what was tracked BEFORE this broadcast (possibly nothing, id `null`) rather
        // than the dry job's own id: the two coincide in the common case (this broadcast IS the
        // tracked dry job transitioning to its terminal state), but using the pre-broadcast
        // snapshot also gets the "nothing was tracked yet" case right — comparing against the
        // dry job's own id there would never match (trackedRef stays null unless something else
        // sets it) and the correction below would never land.
        const preFetchId = current === null ? null : current.id
        void window.argus.distill
          .status(slug)
          .then((real) => {
            // Only adopt if nothing newer has superseded what was tracked when this fired — a
            // broadcast for a genuinely fresher job would already have moved trackedRef past it.
            const stillSame =
              mounted && (trackedRef.current === null ? null : trackedRef.current.id) === preFetchId
            if (stillSame) {
              trackedRef.current = real
              setJob(real)
            }
          })
          .catch(() => undefined)
        return
      }

      trackedRef.current = p.job
      setJob(p.job)
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
 *
 * The in-flight branch checks `dryRun` before anything else: a dry comparison run is not this
 * case's real distillation, and the ACTION this row triggers when in flight (cancel whatever job
 * is tracked) is already correct for either kind — only the wording was wrong. Matches
 * `DistillChip`'s own `job.dryRun ? 'Cancel dry run' : 'Cancel distillation'` split.
 */
export function distillMenuLabel(job: DistillJobRow | null): string {
  if (isDistillInFlight(job)) return job?.dryRun ? 'Cancel dry run' : 'Cancel distillation'
  if (!job) return 'Distill'
  if (job.state !== 'done') return 'Re-distill'
  // `itemCount` is only ever null on a `done` row for a dry run (staging never ran there) —
  // a real job's `done` state always records a number, 0 included. `x && x > 0` would collapse
  // that null into the same branch as a genuine 0, claiming "nothing to distill" as a measured
  // fact this row never measured. Falling back to plain `Re-distill` keeps NULL and 0 apart the
  // way every other reader of `itemCount` in this codebase must.
  if (job.itemCount === null) return 'Re-distill'
  return job.itemCount > 0
    ? `Re-distill · ${job.itemCount} items`
    : 'Re-distill · nothing to distill'
}

/**
 * `{turnCount} turns · {toolCallCount} tool calls · $cost` — the v2 agentic-run usage readout
 * (Task 12's widened DistillJobRow). Each segment is independently optional: the columns are
 * null until a job records them (pre-v2 rows, or one still queued/running), so a segment with a
 * null field is omitted rather than fabricated as "0 turns"/"$0.00". Returns '' (never shown)
 * when every field is null.
 */
export function distillCostLine(job: DistillJobRow | null): string {
  if (!job) return ''
  const parts: string[] = []
  if (job.turnCount !== null) parts.push(`${job.turnCount} turns`)
  if (job.toolCallCount !== null) parts.push(`${job.toolCallCount} tool calls`)
  if (job.costUsd !== null) parts.push(`$${job.costUsd.toFixed(2)}`)
  return parts.join(' · ')
}

/** Latest progress for one job, from `distill:progress`. Resets when `jobId` changes; a broadcast
 *  for another job is ignored. Advisory — a missed broadcast only means a stale phase line. */
export function useDistillProgress(jobId: number | null): DistillProgress | null {
  const [p, setP] = useState<DistillProgress | null>(null)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setP(null)
    if (jobId === null) return
    return window.argus.distill.onProgress((u) => {
      if (u.jobId === jobId) setP(u)
    })
  }, [jobId])
  return p
}
