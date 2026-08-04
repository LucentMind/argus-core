import { useEffect, useState, useSyncExternalStore } from 'react'
import { RefreshCw } from 'lucide-react'
import { JiraAttachmentsDialog } from './JiraAttachmentsDialog'
import { IconBtn, SectionLabel } from './ui'
import { uiStore } from '../lib/uiStore'
import { jiraSyncLine, resultDecayMs, type JiraSyncPhase } from '../lib/jiraSyncState'
import type { JiraRefreshSummary } from '../../../shared/jira'

const LINE_TONE = {
  mute: 'text-mute',
  defect: 'text-defect',
  danger: 'text-danger'
} as const

/**
 * The case's Jira ticket, as an always-open rail section built exactly like `ReposSection`'s
 * repo rows: a two-line box — the ticket's title over its sync line — that highlights on hover
 * and opens Jira, with refresh as an icon button beside it (user-directed, 2026-08-02).
 *
 * It used to be a fixed-width pill in the top bar whose face carried terse counts (`+3 · ↑`)
 * and whose every detail — the prose summary, the error text, "Open in Jira" — lived behind a
 * popover, because a bar control cannot grow without shoving the mode switcher sideways. In a
 * rail panel none of that holds: line 2 says what the pill's face could only abbreviate, the
 * title is the "Open in Jira" it used to hide, and the popover is gone rather than moved.
 *
 * What survives from the pill is the announce-then-decay behaviour: a refresh result holds
 * line 2 for a few seconds and then hands it back to the resting stamp, because the stamp is
 * what answers "should I re-sync" and a line stuck on a result can no longer answer it.
 */
export function JiraSection({
  slug,
  jiraKey,
  title,
  syncedAt
}: {
  slug: string
  jiraKey: string | null
  /** The ticket's title. This is `CaseRecord.title`, which for a case created from a ticket
   *  IS the Jira summary (NewCaseDialog prefills the field from `preview.summary`) — the user
   *  may have edited it at creation, and no separate upstream summary is stored, so this is
   *  both the closest thing to "the Jira title" and the name the rest of the app uses for
   *  this case. */
  title: string
  syncedAt: string | null
}): React.JSX.Element | null {
  const [phase, setPhase] = useState<JiraSyncPhase>({ kind: 'idle' })
  const [lastSynced, setLastSynced] = useState(syncedAt)
  const [pending, setPending] = useState<JiraRefreshSummary | null>(null)
  // The line has finished announcing this result and falls back to the resting stamp.
  const [decayed, setDecayed] = useState(false)
  // derived-state sync: adopt a changed stored value (e.g. the cases list reloads after mount)
  const [prevSyncedAt, setPrevSyncedAt] = useState(syncedAt)
  if (syncedAt !== prevSyncedAt) {
    setPrevSyncedAt(syncedAt)
    setLastSynced(syncedAt)
  }
  const dynamic = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  ).dynamicTheme

  /**
   * A result is an announcement, and announcements have to end.
   *
   * The trigger is a clock rather than "the next interaction" because this section has no
   * interaction left that could carry it: refreshing again already replaces the phase, and the
   * pointer is already sitting on the control after a refresh, so no fresh mouse-enter arrives
   * until the user leaves and comes back — which may be never.
   *
   * Held while the attachments dialog is up: that dialog covers the rail, so the window would
   * otherwise elapse unseen behind it and the user would return to a section that never
   * reacted. `resultDecayMs` returns null for `error`, which is what keeps a failure sticky.
   */
  useEffect(() => {
    if (pending) return
    const ms = resultDecayMs(phase)
    if (ms === null) return
    const t = setTimeout(() => setDecayed(true), ms)
    return () => clearTimeout(t)
  }, [phase, pending])

  if (!jiraKey) return null

  const busy = phase.kind === 'syncing'
  const line = jiraSyncLine(decayed ? { kind: 'idle' } : phase, lastSynced)

  async function refresh(): Promise<void> {
    if (busy) return
    setDecayed(false)
    setPhase({ kind: 'syncing' })
    const r = await window.argus.jira.refreshCase(slug)
    if (r.ok) {
      setPhase({ kind: 'result', summary: r.value })
      setLastSynced(r.value.syncedAt)
      if (r.value.newAttachments.length) setPending(r.value)
    } else {
      setPhase({ kind: 'error', message: r.message })
    }
  }

  return (
    <div
      className={`flex flex-col gap-1 rounded-r3 px-2.5 py-2 ${dynamic ? 'glass-panel' : 'surface-card'}`}
    >
      {/* Section label + ticket id, unlike Repos/Pull request's label-only header: this panel
          used to skip the label entirely on the theory that the title said what it was, but
          without "Jira" or the key anywhere the box read as an unlabeled title card, not
          obviously part of the same rail family (user-directed, 2026-08-04). Tight py-2/gap-1
          rather than the p-2.5/gap-1.5 the other rail sections use: this box has one row of
          content beneath the header, so the extra breathing room those multi-row sections carry
          just reads as dead space here. */}
      <SectionLabel>Ticket · {jiraKey}</SectionLabel>
      <div className="flex items-center gap-1">
        {/* The whole box is the trigger, not the text inside it: the box is what lights up on
            hover, so anything less than the box is a click target that does not match its own
            highlight. */}
        <button
          type="button"
          aria-label={`Open ${jiraKey} in Jira`}
          title={`Open ${jiraKey} in Jira`}
          className="min-w-0 flex-1 rounded-r2 border border-transparent px-2 py-1.5 text-left transition-colors hover:border-hair hover:bg-hair/50"
          onClick={() => void window.argus.jira.openIssue(slug)}
        >
          <div className="truncate text-xs font-medium text-signal">{title}</div>
          {/* One line, truncated, with the full text in the tooltip: an error message or a
              multi-part summary is unbounded and this box sits in a fixed-width rail. */}
          <div
            data-testid="jira-sync-line"
            title={line.text}
            role={line.tone === 'danger' ? 'alert' : undefined}
            className={`mt-0.5 truncate font-mono text-[11px] ${LINE_TONE[line.tone]}`}
          >
            {line.text}
          </div>
        </button>
        <IconBtn
          aria-label="Refresh from Jira"
          title="Refresh from Jira"
          size="xs"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={12} className={busy ? 'animate-spin' : undefined} />
        </IconBtn>
      </div>
      {pending && (
        <JiraAttachmentsDialog
          slug={slug}
          newAttachments={pending.newAttachments}
          deselectedAttachments={pending.deselectedAttachments}
          ingestedAttachments={pending.ingestedAttachments}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  )
}
