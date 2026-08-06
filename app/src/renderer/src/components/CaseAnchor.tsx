import { useLayoutEffect, useRef, useState } from 'react'
import { MenuButton, Checkbox } from './ui'
import { uiStore } from '../lib/uiStore'
import { notice } from '../lib/noticeStore'
import { confirm } from '../lib/confirmStore'
import { useDistillJob, distillMenuLabel, isDistillInFlight } from '../lib/distillJob'
import { CASE_RESOLUTIONS } from '../../../shared/types'
import type { CaseResolution, CaseStatus } from '../../../shared/types'
import type { DistillJobRow } from '../../../shared/distill'

/**
 * The case identity and everything you can do to that case, as one control: the case id IS the
 * menu trigger (user-directed, 2026-08-02). It carried a `⋯` glyph beside the id before, which
 * made the id itself look inert and put a 12px target next to a 60px one that did the same
 * thing. No caret replaces it either — a caret beside a case id promises a list of cases, and
 * this menu opens Close as… / Export / Re-distill / Close case.
 *
 * The box is drawn on hover only, for the same reason the mode switcher's is: a resting border
 * around every control turned the bar into a row of nested rectangles. The border is declared
 * transparent rather than absent so nothing shifts a pixel when it appears.
 *
 * The actions live here rather than in a parent for the same reason `Open in Jira` lives in
 * `JiraSection`: one component owns one subject end to end. `Close case` is what lets the anchor
 * have no `×` — the active case is not in the tab strip any more, so there is no `×` to press.
 */

/** The confirm dialog's checkbox content. Its own `useState` gives it independent re-renders
 *  inside `ConfirmHost`'s static `message` tree; `onChange` reports the current value back to
 *  the caller via closure, since `confirm()` itself only ever resolves accept/cancel. */
function DistillOptIn({
  initial,
  onChange
}: {
  initial: boolean
  onChange: (next: boolean) => void
}): React.JSX.Element {
  const [checked, setChecked] = useState(initial)
  return (
    <Checkbox
      checked={checked}
      onChange={(next) => {
        setChecked(next)
        onChange(next)
      }}
      label="Start distillation"
      aria-label="Start distillation"
    />
  )
}

export function CaseAnchor({
  slug,
  status,
  resolution,
  onStatusChanged,
  onHome
}: {
  slug: string
  status: CaseStatus
  resolution: CaseResolution | null
  /** The status moved in the DB; the owner of the `cases` array must refetch so `status` and
   *  `resolution` above stop being stale. */
  onStatusChanged: () => void
  onHome: () => void
}): React.JSX.Element {
  const tracked = useDistillJob(slug)
  const [override, setOverride] = useState<DistillJobRow | null>(null)
  const [pending, setPending] = useState(false)
  // adjust-state-during-render: any broadcast (tracked) supersedes the optimistic cancel/
  // redistill result — same idiom as DistillChip, whose adoption-over-swallowed-broadcast
  // comment explains why: DistillQueue.emit() swallows broadcast failures, so the row a
  // cancel()/redistill() call resolves with is the only guaranteed-correct source for THIS
  // click's own outcome. A broadcast for a newer job that lands before that response resolves
  // wins here ONLY because `cancelEpochRef` below is captured before the call and checked
  // before adopting it in the handler's `.then()` — the reset in this render-adjust block just
  // makes the newer job visible immediately, on this render, rather than leaving the row on the
  // outgoing job's state until the async response is guarded and discarded. Without the epoch
  // check (this block alone), a stale response landing after this reset re-adopts unconditionally
  // and clobbers the newer job's row with a `cancelled`/`queued` row for the OLD job id — see the
  // F1 regression test, and the identical hazard/idiom explained at length in DistillChip.
  const [prevTracked, setPrevTracked] = useState(tracked)
  if (tracked !== prevTracked) {
    setPrevTracked(tracked)
    setOverride(null)
    // Same idiom as DistillChip's `cancelling` reset in its identical block: without this, a
    // redistill()/cancel() promise that never settles (network hang, dropped IPC reply) leaves
    // `pending` stuck true forever — every click on this row is swallowed by the `if (pending)
    // return` guard above, even once a broadcast has moved `distillJob` on to a state that would
    // otherwise make the click meaningful again. See the N5 regression test.
    setPending(false)
  }
  // Bumped whenever `tracked` changes identity — see DistillChip's `cancelEpochRef` for the full
  // rationale (shared idiom). `react-hooks/refs` forbids writing a ref in the render body above,
  // hence the layout effect.
  const cancelEpochRef = useRef(0)
  useLayoutEffect(() => {
    cancelEpochRef.current += 1
  }, [tracked])
  const distillJob = override ?? tracked

  async function applyStatus(
    next: CaseStatus,
    res: CaseResolution | null,
    distill = true
  ): Promise<void> {
    await window.argus.cases.setStatus(slug, next, res, distill)
    onStatusChanged()
  }

  async function confirmClose(res: CaseResolution): Promise<void> {
    let defaultDistill = true
    try {
      defaultDistill = await window.argus.distill.needsRun(slug)
    } catch (err) {
      console.error('[distill] needsRun failed', err)
      defaultDistill = true
    }
    let distill = defaultDistill
    const ok = await confirm({
      title: `Close case as ${res}?`,
      message: <DistillOptIn initial={defaultDistill} onChange={(next) => (distill = next)} />
    })
    if (!ok) return
    await applyStatus('closed', res, distill)
  }

  async function exportBundle(includeTranscripts: boolean): Promise<void> {
    const r = await window.argus.bundle.export(slug, includeTranscripts)
    if (!r) return // save dialog canceled
    if (r.ok) notice(`exported ${r.fileCount} files`)
    else notice(r.error, 'danger')
  }

  const statusItems = [
    ...CASE_RESOLUTIONS.map((r) => ({
      label: r,
      // The dialog's checkbox only ever does anything on an actual open→closed transition —
      // `setCaseStatus`'s `closingNow` guard (caseService.ts) never fires the distill hook on a
      // closed→closed re-resolve, so showing the checkbox there would be a false affordance.
      // Re-resolving an already-closed case keeps the pre-branch direct-apply behavior instead.
      onSelect: () => void (status === 'closed' ? applyStatus('closed', r) : confirmClose(r))
    })),
    ...(status === 'closed'
      ? [{ label: 'Reopen', onSelect: () => void applyStatus('open', null) }]
      : [])
  ]

  // The "Close as…" row doubles as the status readout: a closed case shows its resolution.
  const closeAsLabel =
    status === 'closed' ? (resolution ? `Closed · ${resolution}` : 'Closed') : 'Close as…'

  return (
    <div className="flex shrink-0 items-center">
      <MenuButton
        // `text-signal` below, not `text-defect` (user-directed, 2026-08-01): a case id is an
        // identifier, and the dashboard has always drawn it in signal blue (`CaseCard`'s slug).
        // The header drawing the SAME id in amber made one thing look like two, and spent the
        // attention colour on a label that is never a problem.
        label={slug}
        aria-label={`Case actions · ${slug}`}
        align="left"
        nocaret
        // `!` markers, not plain classes: an appended utility of equal specificity loses to
        // Btn's own base string on source order alone (h-7/px-3/text-xs), so a bare `h-[30px]`
        // here would be silently inert. The transparent resting border and the hover fill come
        // from MenuButton's default `ghost` variant; only the hover hairline is added.
        triggerClassName="h-[30px]! px-2.5! font-mono text-sm! text-signal! hover:border-hair!"
        items={[
          { label: closeAsLabel, children: statusItems },
          {
            label: 'Export',
            children: [
              { label: 'Export case…', onSelect: () => void exportBundle(true) },
              { label: 'Export without transcripts…', onSelect: () => void exportBundle(false) }
            ]
          },
          {
            // No status guard: distilling an open case is allowed on purpose (user-directed,
            // 2026-08-03). Output stages as inert proposals a human accepts, so an early run
            // cannot reach the knowledge corpus on its own. While a job is in flight this same
            // row is the way to stop it — one row, one subject.
            label: distillMenuLabel(distillJob),
            onSelect: () => {
              // Guards the same double-click hazard DistillChip's `retrying`/`cancelling`
              // guard against a stale response, but here the guard also must cover a plain
              // double-click before the FIRST response ever lands: with no broadcast yet and
              // no optimistic row adopted yet, a second click before `pending` existed would
              // still read the old `distillJob` and issue a second `redistill()`, enqueuing
              // two jobs — the same "two jobs for one case" hazard reconcileAndEnqueue exists
              // to prevent on the close path.
              if (pending) return
              setPending(true)
              const inFlight = isDistillInFlight(distillJob)
              const epoch = cancelEpochRef.current
              const p = inFlight
                ? window.argus.distill.cancel(distillJob!.id)
                : window.argus.distill.redistill(slug)
              void p
                .then((row) => {
                  if (cancelEpochRef.current === epoch) setOverride(row)
                })
                .catch(() => undefined)
                .finally(() => setPending(false))
            }
          },
          {
            label: 'Close case',
            onSelect: () => {
              uiStore.closeTab(slug)
              onHome()
            }
          }
        ]}
      />
    </div>
  )
}
