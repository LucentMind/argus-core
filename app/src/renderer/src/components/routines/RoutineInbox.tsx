import { useState } from 'react'
import { Btn, Chip, SectionLabel } from '../ui'
import { chipStamp } from '../../lib/time'
import { useRoutinesPayload } from '../../lib/routinesStore'
import { RUN_TONE, RunSummaryText, TriggerChip } from './runDisplay'

/**
 * What unattended work did, on the surface the user actually lands on.
 *
 * Increment 1 and 2 put run history behind Settings -> Routines, which is not where anyone
 * looks in the morning; a routine that runs overnight and reports into a settings page has done
 * the work and failed to deliver it. This section sits above the case grid and disappears
 * completely when there is nothing to review, so a user with no routines never sees it.
 *
 * It renders the runs the payload carries (capped at 50 by listRoutineRuns) but prints
 * `unreviewedCount`, which is a SQL count over every row — so a backlog deeper than the window
 * reports honestly, and "Mark all reviewed" clears all of it.
 */
export function RoutineInbox({
  onOpen
}: {
  onOpen: (slug: string) => void
}): React.JSX.Element | null {
  const { payload } = useRoutinesPayload()
  /**
   * Separate from the payload itself, same reasoning as RoutinesPage's `mutationError`: the
   * store re-reads on the routines:changed broadcast and that is the only thing allowed to
   * change what is shown here, so a failed mutation must surface a message without touching
   * the list underneath it.
   */
  const [mutationError, setMutationError] = useState<string | null>(null)

  if (!payload || payload.unreviewedCount === 0) return null

  // Same predicate main counts with: a run still going is not a result to review.
  const pending = payload.runs.filter((r) => r.status !== 'running' && r.reviewedAt === null)
  const nameOf = (routineId: string): string =>
    payload.routines.find((r) => r.id === routineId)?.name ?? routineId

  async function markReviewed(id: number): Promise<void> {
    try {
      // Reply discarded on purpose — the store owns the payload and refreshes on the broadcast,
      // same as every other window sees it. Adopting the reply here would be a second source of
      // truth racing the one the store already provides.
      await window.argus.routines.markReviewed(id)
      setMutationError(null)
    } catch (e) {
      setMutationError((e as Error).message)
    }
  }

  async function markAllReviewed(): Promise<void> {
    try {
      await window.argus.routines.markAllReviewed()
      setMutationError(null)
    } catch (e) {
      setMutationError((e as Error).message)
    }
  }

  return (
    <section className="flex flex-col gap-2" data-testid="routine-inbox">
      <div className="flex items-center justify-between gap-4">
        <SectionLabel>Routine runs · {payload.unreviewedCount} to review</SectionLabel>
        <Btn onClick={() => void markAllReviewed()}>Mark all reviewed</Btn>
      </div>
      {mutationError && (
        <p
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 p-2 text-xs text-danger"
        >
          {mutationError}
        </p>
      )}
      <div className="flex flex-col divide-y divide-hair2 rounded-r2 border border-hair2 bg-overlay">
        {pending.map((run) => {
          const name = nameOf(run.routineId)
          return (
            <div key={run.id} className="flex items-start gap-3 px-4 py-2.5 text-xs">
              <Chip tone={RUN_TONE[run.status]}>
                <span data-testid={`run-status-${run.id}`}>{run.status}</span>
              </Chip>
              <TriggerChip run={run} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-ink">
                  {name} · {run.finishedAt ? chipStamp(run.finishedAt) : ''}
                </span>
                {run.error && <RunSummaryText text={run.error} kind="error" />}
                {run.summary && <RunSummaryText text={run.summary} kind="summary" />}
                {!run.error && !run.summary && <p className="text-faint">no output recorded</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Btn aria-label={`Open case · ${name}`} onClick={() => onOpen(run.caseSlug)}>
                  Open case
                </Btn>
                <Btn
                  aria-label={`Mark reviewed · ${name}`}
                  onClick={() => void markReviewed(run.id)}
                >
                  Mark reviewed
                </Btn>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
