import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Btn } from './ui'
import { JiraAttachmentsDialog } from './JiraAttachmentsDialog'
import { shortStamp } from '../lib/time'
import type { JiraRefreshSummary } from '../../../shared/jira'

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
  if (s.commentsError) parts.push(`comments fetch failed`)
  return parts.length ? parts.join(' · ') : 'no changes'
}

function RefreshIcon({ spinning }: { spinning: boolean }): React.JSX.Element {
  return (
    <RefreshCw
      size={12}
      strokeWidth={1.75}
      className={spinning ? 'animate-spin' : undefined}
      aria-hidden="true"
    />
  )
}

export function JiraRefreshButton({
  slug,
  jiraKey,
  syncedAt
}: {
  slug: string
  jiraKey: string | null
  syncedAt: string | null
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastSynced, setLastSynced] = useState(syncedAt)
  const [pending, setPending] = useState<JiraRefreshSummary | null>(null)
  // derived-state sync: adopt a changed stored value (e.g. cases reload after mount)
  const [prevSyncedAt, setPrevSyncedAt] = useState(syncedAt)
  if (syncedAt !== prevSyncedAt) {
    setPrevSyncedAt(syncedAt)
    setLastSynced(syncedAt)
  }
  if (!jiraKey) return null

  async function refresh(): Promise<void> {
    setBusy(true)
    setNote(null)
    setError(null)
    const r = await window.argus.jira.refreshCase(slug)
    setBusy(false)
    if (r.ok) {
      setNote(summarize(r.value))
      setLastSynced(r.value.syncedAt)
      if (r.value.newAttachments.length) setPending(r.value)
    } else setError(r.message)
  }

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Btn variant="outline" className="shrink-0" disabled={busy} onClick={() => void refresh()}>
          <RefreshIcon spinning={busy} />
          {busy ? 'Refreshing…' : 'Refresh'}
        </Btn>
        {lastSynced && (
          <span className="shrink-0 text-xs text-mute">
            last refreshed {shortStamp(lastSynced)}
          </span>
        )}
        {note && <span className="min-w-0 truncate text-xs text-dim">{note}</span>}
        {error && (
          <span role="alert" className="min-w-0 truncate text-xs text-danger">
            {error}
          </span>
        )}
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
    </>
  )
}
