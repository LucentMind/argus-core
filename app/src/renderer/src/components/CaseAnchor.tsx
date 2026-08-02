import { MenuButton } from './ui'
import { uiStore } from '../lib/uiStore'
import { notice } from '../lib/noticeStore'
import { useDistillJob, distillMenuLabel } from '../lib/distillJob'
import { CASE_RESOLUTIONS } from '../../../shared/types'
import type { CaseResolution, CaseStatus } from '../../../shared/types'

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
  const distillJob = useDistillJob(slug)

  async function applyStatus(next: CaseStatus, res: CaseResolution | null): Promise<void> {
    await window.argus.cases.setStatus(slug, next, res)
    onStatusChanged()
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
      onSelect: () => void applyStatus('closed', r)
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
            label: distillMenuLabel(distillJob),
            disabled: status !== 'closed',
            onSelect: () => void window.argus.distill.redistill(slug).catch(() => undefined)
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
