import { useState } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'
import { JiraAttachmentsDialog } from './JiraAttachmentsDialog'
import { jiraPillFace, type JiraPillPhase, type JiraPillTone } from '../lib/jiraPillState'
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
  // derived-state sync: adopt a changed stored value (e.g. the cases list reloads after mount)
  const [prevSyncedAt, setPrevSyncedAt] = useState(syncedAt)
  if (syncedAt !== prevSyncedAt) {
    setPrevSyncedAt(syncedAt)
    setLastSynced(syncedAt)
  }
  if (!jiraKey) return null

  const busy = phase.kind === 'syncing'
  const face = jiraPillFace(phase, lastSynced)

  async function refresh(): Promise<void> {
    if (busy) return
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
