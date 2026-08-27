import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Plus, RefreshCw, Unlink } from 'lucide-react'
import { JiraAttachmentsDialog } from './JiraAttachmentsDialog'
import { AddSourceTicketDialog } from './AddSourceTicketDialog'
import { CollapsibleSection } from './CollapsibleSection'
import { IconBtn, SectionLabel } from './ui'
import { uiStore } from '../lib/uiStore'
import { confirm } from '../lib/confirmStore'
import { jiraSyncLine, resultDecayMs, type JiraSyncPhase } from '../lib/jiraSyncState'
import type { JiraRefreshSummary, JiraSourceLink } from '../../../shared/jira'
import type { TicketProviderId } from '../../../shared/ticketRef'

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
  syncedAt,
  ticketProvider = 'jira'
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
  /** `CaseRecord.ticketProvider` — the single authority on which tracker `jiraKey` names.
   *  Defaults to 'jira', matching every caller that predates GitHub support. Source tickets
   *  stay Jira-only this increment, so a GitHub-provider case hides that whole sub-section
   *  rather than offering an affordance that cannot work. */
  ticketProvider?: TicketProviderId
}): React.JSX.Element | null {
  const isGithub = ticketProvider === 'github'
  const trackerName = isGithub ? 'GitHub' : 'Jira'
  const [phase, setPhase] = useState<JiraSyncPhase>({ kind: 'idle' })
  const [lastSynced, setLastSynced] = useState(syncedAt)
  const [pending, setPending] = useState<JiraRefreshSummary | null>(null)
  const [sources, setSources] = useState<JiraSourceLink[]>([])
  const [adding, setAdding] = useState(false)
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

  /** The case's source tickets. Reloaded rather than mutated locally after an add or an unlink,
   *  so what the section shows is always what the main process actually has linked.
   *
   *  A case with no ticket of its own is a no-op, not a fetch: this hook necessarily runs
   *  BEFORE the `!jiraKey` early return below, and that case renders no section at all — so
   *  there is nothing to show the answer in, and nothing to discover clone links from either. */
  const loadSources = useCallback((): Promise<void> => {
    // Source tickets are Jira-only this increment: a GitHub-provider case has nothing to
    // load and nothing to show, so skip the round trip entirely rather than fetch for a
    // section that renders nothing.
    if (!jiraKey || isGithub) return Promise.resolve()
    return window.argus.jira.listSources(slug).then((r) => {
      if (r.ok) setSources(r.value)
    })
  }, [slug, jiraKey, isGithub])

  useEffect(() => {
    void loadSources()
  }, [loadSources])

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
      // Open when the primary OR any source has something to offer: a refresh that found files
      // only on a source ticket is still a decision the user has to make.
      if (r.value.newAttachments.length || r.value.sources.some((s) => s.newAttachments.length))
        setPending(r.value)
    } else {
      setPhase({ kind: 'error', message: r.message })
    }
  }

  /** Not `danger: true`: unlinking stops the sync, it does not delete anything — the evidence
   *  already imported from the source stays, which is exactly what the message says. */
  async function unlink(key: string): Promise<void> {
    if (
      !(await confirm({
        title: `Unlink ${key}?`,
        message: `${key} stops syncing into this case. Evidence already imported from it is kept.`,
        confirmLabel: 'Unlink'
      }))
    )
      return
    const r = await window.argus.jira.removeSource(slug, key)
    if (r.ok) void loadSources()
  }

  return (
    <CollapsibleSection
      id="jira"
      name="Ticket"
      className={`flex flex-col gap-1 rounded-r3 px-2.5 py-2 ${dynamic ? 'glass-panel' : 'surface-card'}`}
      // Section label + ticket id, unlike Repos/Pull request's label-only header: this panel
      // used to skip the label entirely on the theory that the title said what it was, but
      // without "Jira" or the key anywhere the box read as an unlabeled title card, not
      // obviously part of the same rail family (user-directed, 2026-08-04).
      header={<SectionLabel>Ticket · {jiraKey}</SectionLabel>}
    >
      {/* Tight py-2/gap-1 rather than the p-2.5/gap-1.5 the other rail sections use: this box has
          one row of content beneath the header, so the extra breathing room those multi-row
          sections carry just reads as dead space here. */}
      <div className="flex items-center gap-1">
        {/* The whole box is the trigger, not the text inside it: the box is what lights up on
            hover, so anything less than the box is a click target that does not match its own
            highlight. */}
        <button
          type="button"
          aria-label={`Open ${jiraKey} in ${trackerName}`}
          title={`Open ${jiraKey} in ${trackerName}`}
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
        {/* Add sits beside refresh rather than under the list: both act on the whole section
            rather than on a row, and a full-width button below the sources claimed a band of
            rail height permanently for an action taken once or twice per case. Hidden entirely
            for a GitHub-provider case: source tickets are Jira-only this increment, and an
            affordance that cannot work is worse than none. */}
        {!isGithub && (
          <IconBtn
            aria-label="Add source ticket"
            title="Add source ticket"
            size="xs"
            onClick={() => setAdding(true)}
          >
            <Plus size={12} />
          </IconBtn>
        )}
        <IconBtn
          aria-label={`Refresh from ${trackerName}`}
          title={`Refresh from ${trackerName}`}
          size="xs"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={12} className={busy ? 'animate-spin' : undefined} />
        </IconBtn>
      </div>
      {/* No empty state and no list header: a case with no sources renders nothing at all here,
          so the section reads exactly as it did before sources existed. Sources are Jira-only,
          so a GitHub-provider case never renders any of this — `sources` also stays empty for
          it, since `loadSources` skips the fetch above. */}
      {!isGithub &&
        sources.map((s) => (
          <div key={s.key} className="flex items-center gap-1 pl-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">{s.key}</span>
            <IconBtn
              aria-label={`Unlink ${s.key}`}
              title={`Unlink ${s.key}`}
              size="xs"
              onClick={() => void unlink(s.key)}
            >
              {/* Same icon ReposSection uses for its unlink: this detaches a source, it does not
                  delete anything, and an X reads as "remove/close" in a way that invites the
                  opposite reading. */}
              <Unlink size={11} />
            </IconBtn>
          </div>
        ))}
      {!isGithub && adding && (
        <AddSourceTicketDialog
          slug={slug}
          jiraKey={jiraKey}
          existing={sources.map((s) => s.key)}
          onClose={() => setAdding(false)}
          onAdded={() => void loadSources()}
        />
      )}
      {pending && (
        <JiraAttachmentsDialog
          slug={slug}
          groups={[
            {
              jiraKey,
              role: 'primary',
              newAttachments: pending.newAttachments,
              deselectedAttachments: pending.deselectedAttachments,
              ingestedAttachments: pending.ingestedAttachments
            },
            // A source that errored is excluded: it has no findings to act on, and an empty
            // group for an unreadable ticket would read as "nothing new" rather than "could
            // not read". Its error surfaces in the sync line instead.
            ...pending.sources
              .filter((s) => !s.error)
              .map((s) => ({
                jiraKey: s.key,
                role: 'source' as const,
                newAttachments: s.newAttachments,
                deselectedAttachments: s.deselectedAttachments,
                ingestedAttachments: []
              }))
          ]}
          onClose={() => setPending(null)}
        />
      )}
    </CollapsibleSection>
  )
}
