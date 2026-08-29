import { useLayoutEffect, useRef, useState } from 'react'
import { MenuButton, Checkbox } from './ui'
import { DistillRunPanel } from './DistillRunPanel'
import { uiStore } from '../lib/uiStore'
import { notice } from '../lib/noticeStore'
import { choose, confirm } from '../lib/confirmStore'
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

/** The tooltip on a disabled Archive/Restore row, keyed on the operation actually in flight.
 *  One table so the two rows cannot drift into describing different operations, and so neither
 *  can assert an archive when what is running is a restore. */
const BUSY_TITLE: Record<'archive' | 'restore', string> = {
  archive: 'An archive is already running for this case',
  restore: 'A restore is already running for this case'
}

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
  archivedAt,
  onStatusChanged,
  onHome
}: {
  slug: string
  status: CaseStatus
  resolution: CaseResolution | null
  /** `CaseRecord.archivedAt` — non-null once the case's evidence, artifacts and transcripts
   *  live in a bundle instead of on disk. It decides which of Archive/Restore this menu offers,
   *  and whether deleting the case has an archive to ask about at all. Kept fresh by App.tsx's
   *  `cases:changed` subscription, so a case archived in ANOTHER window stops offering Archive
   *  here too. */
  archivedAt: string | null
  /** The status moved in the DB; the owner of the `cases` array must refetch so `status` and
   *  `resolution` above stop being stale. */
  onStatusChanged: () => void
  onHome: () => void
}): React.JSX.Element {
  const tracked = useDistillJob(slug)
  const [override, setOverride] = useState<DistillJobRow | null>(null)
  const [pending, setPending] = useState(false)
  // Archive/restore get their OWN busy flag rather than sharing `pending` with the distill and
  // dry-run rows. Two reasons, and both are real defects the shared flag had:
  //  - the tooltip. `pending` is set by the distill row and the dry-run row, so during a
  //    distillation these rows rendered disabled under "An archive or restore is already
  //    running", which was simply false.
  //  - the guard. The render-adjust block below calls `setPending(false)` whenever the tracked
  //    distill job changes identity, so an unrelated `distill:changed` broadcast RE-ENABLED the
  //    Archive row mid-archive. This flag is owned by these two handlers alone and nothing
  //    else clears it.
  const [archiveBusy, setArchiveBusy] = useState<'archive' | 'restore' | null>(null)
  const [runsOpen, setRunsOpen] = useState(false)
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

  /**
   * Archiving is REFUSED — not queued, not forced — while the case still has an agent turn, a
   * routine run or an external app window live in it, and the main process answers with a
   * sentence naming exactly what to finish (caseLiveWork.ts). That sentence is the one error on
   * this menu the user can actually act on, so it goes to the notice slot beside the mode
   * switch, the same place a failed export reports. Swallowing it would leave a menu row that
   * silently does nothing.
   */
  async function archiveCase(): Promise<void> {
    const ok = await confirm({
      title: `Archive ${slug}?`,
      // Deliberately not "frees space in the database": archiving frees the case's FILES, which
      // is the bulk of it. The SQLite file itself does not shrink (its incremental vacuum is a
      // no-op on an ordinary installation), and promising otherwise would be a measurable lie.
      message:
        'Evidence, artifacts and transcripts move to a zip in your archive folder, freeing ' +
        'their disk space. Findings, RCA and the case summary stay — the case keeps helping ' +
        'future cases. You can restore it any time.',
      confirmLabel: 'Archive'
    })
    if (!ok) return
    setArchiveBusy('archive')
    try {
      await window.argus.cases.archive(slug)
    } catch (err) {
      notice((err as Error).message, 'danger')
    } finally {
      setArchiveBusy(null)
    }
  }

  async function restoreCase(): Promise<void> {
    setArchiveBusy('restore')
    try {
      await window.argus.cases.restore(slug)
    } catch (err) {
      notice((err as Error).message, 'danger')
    } finally {
      setArchiveBusy(null)
    }
  }

  async function deleteCase(): Promise<void> {
    // Three buttons rather than a checkbox: confirmStore has no checkbox primitive, and
    // `choose` exists for exactly this shape — "no" and "yes, but differently" as separate
    // answers. The archive branch only appears when there IS an archive to keep.
    //
    // The two branches destroy DIFFERENT things, so they get different sentences. One shared
    // message was written for the archived case — where the evidence and transcripts genuinely
    // survive in the bundle unless the user says otherwise — and on a never-archived case that
    // same silence hides the whole of the loss: there is no bundle anywhere, and the evidence,
    // transcripts and case directory go with the row.
    const choice = archivedAt
      ? await choose({
          title: `Delete ${slug}?`,
          message:
            'Its findings, RCA and summary are removed permanently, and future cases will no ' +
            'longer see it in related history. Its evidence and transcripts are in the archive ' +
            'bundle — choose whether that goes too.',
          confirmLabel: 'Delete everything',
          danger: true,
          altLabel: 'Delete, keep the archive',
          altDanger: true
        })
      : (await confirm({
            title: `Delete ${slug}?`,
            message:
              'This deletes everything: every evidence file, every transcript and the case ' +
              'directory itself, along with its findings, RCA and summary. There is no archive ' +
              'bundle to fall back on, and future cases will no longer see it in related ' +
              'history.',
            confirmLabel: 'Delete',
            danger: true
          }))
        ? 'confirm'
        : 'cancel'
    if (choice === 'cancel') return
    try {
      // `archivedAt ?` guard, not a bare `choice === 'confirm'`: on a case that was never
      // archived the only reachable answer IS 'confirm', and passing `deleteArchive: true`
      // there would claim to delete a bundle that does not exist. The flag says what it means.
      await window.argus.cases.delete(slug, {
        deleteArchive: archivedAt ? choice === 'confirm' : false
      })
    } catch (err) {
      // Navigating home on a REFUSED delete (deleteCase rejects a case that is mid-archive)
      // would present the failure as a success — the case is still there, just no longer on
      // screen. Report it and stay put.
      notice((err as Error).message, 'danger')
      return
    }
    uiStore.closeTab(slug)
    onHome()
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
    <>
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
              // A noun beside the verb above: that row starts/stops a run, this one reads the last
              // one. Kept separate so neither has to change meaning by state.
              label: 'Distillation details…',
              onSelect: () => setRunsOpen(true)
            },
            {
              // Non-destructive to the KNOWLEDGE CORPUS by construction: the pipeline runs,
              // staging does not, and `ignorePriorProposals` keeps this case's own prior
              // proposals out of the input so the veto does not drop every candidate as
              // `duplicate` before v3 is exercised. It is NOT non-destructive to an in-flight
              // job, though: `enqueueDryRun` takes the same one-job-per-case slot as a real
              // distill and calls the same `cancelOtherInFlight` enqueue() does — with no guard
              // here, clicking this row while a REAL distillation is running would silently
              // cancel it (losing real agent time/spend) from a row explicitly framed as the
              // safe one. Disabled while anything is in flight (dry run included — a second dry
              // run only replaces the first, still not something to do silently) rather than
              // confirmed: this row's whole premise is "nothing to lose by clicking it", and a
              // confirm dialog would only be needed for a genuinely destructive action.
              label: 'Dry run (compare)…',
              disabled: isDistillInFlight(distillJob),
              title: isDistillInFlight(distillJob)
                ? 'A distillation is already running for this case'
                : undefined,
              onSelect: () => {
                if (pending || isDistillInFlight(distillJob)) return
                setPending(true)
                void window.argus.distill
                  .dryRun(slug, true)
                  .catch(() => undefined)
                  .finally(() => setPending(false))
              }
            },
            ...(archivedAt
              ? [
                  {
                    // `disabled`/`title` as well as the guard, matching the Dry run row above:
                    // the guard alone left a row that looked live and silently did nothing.
                    label: 'Restore from archive',
                    disabled: archiveBusy !== null,
                    // Names what is ACTUALLY running. The tooltip used to read off `pending`,
                    // which the distill and dry-run rows also set, so a distillation in flight
                    // asserted an archive was running.
                    title: archiveBusy ? BUSY_TITLE[archiveBusy] : undefined,
                    onSelect: () => {
                      if (archiveBusy) return
                      void restoreCase()
                    }
                  }
                ]
              : [
                  {
                    label: 'Archive case…',
                    disabled: archiveBusy !== null,
                    title: archiveBusy ? BUSY_TITLE[archiveBusy] : undefined,
                    onSelect: () => {
                      if (archiveBusy) return
                      void archiveCase()
                    }
                  }
                ]),
            {
              label: 'Close case',
              onSelect: () => {
                uiStore.closeTab(slug)
                onHome()
              }
            },
            {
              // The only delete affordance for the case you are LOOKING at — the dashboard
              // card's hover trash icon still owns deleting a case from the list. Kept here
              // because the archive question ("keep the bundle?") is asked where `archivedAt`
              // is known, and this is the surface that knows it.
              //
              // `danger` tone, like every other destructive row in the app (see
              // ConnectorsSettings' Remove): this is the app's highest-blast-radius menu item
              // and it sat in the same default ink as `Export`, one row under the benign
              // `Close case`.
              label: 'Delete case…',
              tone: 'danger',
              onSelect: () => void deleteCase()
            }
          ]}
        />
      </div>
      {runsOpen && <DistillRunPanel slug={slug} onClose={() => setRunsOpen(false)} />}
    </>
  )
}
