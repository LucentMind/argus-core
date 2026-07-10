import { useState } from 'react'
import { Btn } from './ui'
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
  return parts.length ? parts.join(' · ') : 'no changes'
}

function RefreshIcon({ spinning }: { spinning: boolean }): React.JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? 'animate-spin' : undefined}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
    </svg>
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
    } else setError(r.message)
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      {lastSynced && (
        <span className="shrink-0 text-xs text-mute">
          last refreshed {new Date(lastSynced).toLocaleString()}
        </span>
      )}
      <Btn variant="outline" className="shrink-0" disabled={busy} onClick={() => void refresh()}>
        <RefreshIcon spinning={busy} />
        {busy ? 'Refreshing…' : 'Refresh from Jira'}
      </Btn>
      {note && <span className="min-w-0 truncate text-xs text-dim">{note}</span>}
      {error && (
        <span role="alert" className="min-w-0 truncate text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  )
}
