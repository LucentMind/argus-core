import { MenuButton } from './ui'
import { uiStore } from '../lib/uiStore'
import { notice } from '../lib/noticeStore'
import { useDistillJob, distillMenuLabel } from '../lib/distillJob'
import { CASE_RESOLUTIONS } from '../../../shared/types'
import type { CaseResolution, CaseStatus } from '../../../shared/types'

/**
 * The case identity and everything you can do to that case, inside one border, so they read
 * as one object rather than a label that mysteriously opens a menu.
 *
 * The trigger glyph is `⋯`, not `▾`. A caret beside a case id promises a list of cases; this
 * menu opens Close as… / Export / Re-distill / Close case. That mismatch is why the old bar
 * read as missing a case selector. `⋯` beside a case id is the pattern browsers and editors
 * already use for "actions on this tab".
 *
 * The actions live here rather than in a parent for the same reason `Open in Jira` lives in
 * `JiraPill`: one component owns one subject end to end. `Close case` is what lets the anchor
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
    <div className="flex h-[30px] shrink-0 items-center gap-1 rounded-r2 border border-hair pl-2.5">
      {/* `text-signal`, not `text-defect` (user-directed, 2026-08-01): a case id is an
          identifier, and the dashboard has always drawn it in signal blue (`CaseCard`'s slug).
          The header drawing the SAME id in amber made one thing look like two, and spent the
          attention colour on a label that is never a problem. */}
      <span className="font-mono text-sm text-signal">{slug}</span>
      <MenuButton
        label={<span aria-hidden="true">⋯</span>}
        aria-label={`Case actions · ${slug}`}
        align="left"
        nocaret
        // `!` markers, not plain classes: unlayered stylesheet order beats `@layer utilities`,
        // so a bare `px-1.5` appended to a ui.tsx primitive's trigger is silently inert.
        triggerClassName="px-1.5! text-mute! hover:text-ink!"
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
