import { useEffect, useState } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'
import { JiraAttachmentsDialog } from './JiraAttachmentsDialog'
import {
  jiraPillFace,
  resultDecayMs,
  type JiraPillPhase,
  type JiraPillTone
} from '../lib/jiraPillState'
import { chipStamp } from '../lib/time'
import type { JiraRefreshSummary } from '../../../shared/jira'

const TONE: Record<JiraPillTone, string> = {
  neutral: 'border-hair2 text-dim',
  busy: 'border-hair2 text-dim',
  changed: 'border-defect/40 text-defect',
  error: 'border-danger/45 text-danger',
  stale: 'border-hair2 text-defect'
}

/** Prose form of a refresh result — the popover's line, kept out of the face so a landing
 *  refresh cannot change the pill's width. Mirrors the old JiraRefreshButton.summarize(). */
function summarize(s: JiraRefreshSummary): string {
  const parts: string[] = []
  if (s.newAttachments.length)
    parts.push(
      `${s.newAttachments.length} new attachment${s.newAttachments.length === 1 ? '' : 's'}`
    )
  if (s.statusChange) parts.push(`status ${s.statusChange.from} → ${s.statusChange.to}`)
  if (s.deletedOnJira.length)
    parts.push(
      `${s.deletedOnJira.length} attachment${s.deletedOnJira.length === 1 ? '' : 's'} deleted on Jira (kept locally)`
    )
  if (s.newComments) parts.push(`${s.newComments} new comment${s.newComments === 1 ? '' : 's'}`)
  if (s.commentsError) parts.push('comments fetch failed')
  return parts.length ? parts.join(' · ') : 'no changes'
}

/**
 * Jira, as one fixed-width control (`w-52`, 208px) that renders every state in the same
 * footprint — the property that stops a completed refresh from shoving the mode switcher
 * sideways while the user is reaching for it.
 *
 * The face is the popover trigger; the divided right segment refreshes directly, so the
 * common case stays one click. Everything the face had to drop — the prose summary, the
 * error text, the issue status, "Open in Jira" — lives in the popover, which is also why
 * the case-actions menu no longer carries a Jira item: this component owns Jira end to end.
 */
export function JiraPill({
  slug,
  jiraKey,
  syncedAt
}: {
  slug: string
  jiraKey: string | null
  syncedAt: string | null
}): React.JSX.Element | null {
  const [phase, setPhase] = useState<JiraPillPhase>({ kind: 'idle' })
  const [lastSynced, setLastSynced] = useState(syncedAt)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<JiraRefreshSummary | null>(null)
  // The face has finished announcing this result. `phase` is untouched, so the popover keeps
  // the detail; only the face falls back to the resting stamp.
  const [decayed, setDecayed] = useState(false)
  // derived-state sync: adopt a changed stored value (e.g. the cases list reloads after mount)
  const [prevSyncedAt, setPrevSyncedAt] = useState(syncedAt)
  if (syncedAt !== prevSyncedAt) {
    setPrevSyncedAt(syncedAt)
    setLastSynced(syncedAt)
  }

  /**
   * A result is an announcement, and announcements have to end: the resting stamp is what
   * answers "should I re-sync", so a face stuck on `+3 · ↑` can no longer answer the question
   * the pill exists to answer.
   *
   * The trigger is a clock rather than "the next interaction" because this pill has no
   * interaction left that could carry it. Refreshing again already replaces the phase; opening
   * the popover is the one moment the result detail must survive, since that is what the click
   * is asking for; and the pointer is already sitting on the pill after a refresh, so no fresh
   * mouse-enter arrives until the user leaves and comes back — which may be never. Every
   * interaction trigger also leaves the stuck-face bug intact for a user who refreshes and
   * walks away. A clock is the only one that bounds it.
   *
   * Held while the attachments dialog is up: that dialog covers the pill, so the window would
   * otherwise elapse unseen behind it and the user would return to a pill that never reacted.
   * `resultDecayMs` returns null for `error`, which is what keeps a failure sticky.
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
  const face = jiraPillFace(decayed ? { kind: 'idle' } : phase, lastSynced)

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
    <>
      <div
        className={`flex h-[30px] w-52 shrink-0 items-center overflow-hidden rounded-r2 border bg-hair/30 ${TONE[face.tone]}`}
      >
        <button
          type="button"
          aria-label="Jira details"
          aria-expanded={open}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 transition-colors hover:bg-hair"
          onClick={() => setOpen((v) => !v)}
        >
          {busy ? (
            <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden="true" />
          ) : (
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rotate-45 rounded-[2px] border-[1.5px] border-current"
            />
          )}
          <span className="truncate font-mono text-[11.5px]">{jiraKey}</span>
          <span data-testid="jira-pill-state" className="ml-auto pl-1.5 font-mono text-[11px]">
            {face.label}
          </span>
        </button>
        <button
          type="button"
          aria-label="Refresh from Jira"
          disabled={busy}
          className="flex h-full w-7 shrink-0 items-center justify-center border-l border-hair text-mute transition-colors hover:text-ink disabled:opacity-40"
          onClick={() => void refresh()}
        >
          <RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full z-20 mt-1 w-72 rounded-r2 border border-hair2 bg-overlay p-3 shadow-lg">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-signal">{jiraKey}</span>
              {phase.kind === 'result' && phase.summary.statusChange && (
                <span className="text-[11px] text-mute">{phase.summary.statusChange.to}</span>
              )}
            </div>
            <div className="mt-2 border-t border-hair pt-2 text-xs text-dim">
              {lastSynced ? `Last refreshed ${chipStamp(lastSynced)}` : 'Never refreshed'}
              {phase.kind === 'result' && <div className="mt-1">{summarize(phase.summary)}</div>}
              {phase.kind === 'error' && (
                <div role="alert" className="mt-1 text-danger">
                  {phase.message}
                </div>
              )}
            </div>
            <div className="mt-2 flex gap-2 border-t border-hair pt-2">
              <button
                type="button"
                aria-label="Refresh now"
                disabled={busy}
                className="rounded-r2 border border-hair2 px-2 py-1 text-xs text-dim transition-colors hover:text-ink disabled:opacity-40"
                onClick={() => void refresh()}
              >
                Refresh now
              </button>
              <button
                type="button"
                aria-label="Open in Jira"
                className="rounded-r2 border border-hair2 px-2 py-1 text-xs text-dim transition-colors hover:text-ink"
                onClick={() => {
                  setOpen(false)
                  void window.argus.jira.openIssue(slug)
                }}
              >
                Open in Jira
              </button>
            </div>
          </div>
        </>
      )}
      {pending && (
        <JiraAttachmentsDialog
          slug={slug}
          newAttachments={pending.newAttachments}
          deselectedAttachments={pending.deselectedAttachments}
          ingestedAttachments={pending.ingestedAttachments}
          onClose={() => setPending(null)}
        />
      )}
    </>
  )
}
