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

export function JiraRefreshButton({
  slug,
  jiraKey
}: {
  slug: string
  jiraKey: string | null
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!jiraKey) return null

  async function refresh(): Promise<void> {
    setBusy(true)
    setNote(null)
    setError(null)
    const r = await window.argus.jira.refreshCase(slug)
    setBusy(false)
    if (r.ok) setNote(summarize(r.value))
    else setError(r.message)
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Btn variant="ghost" disabled={busy} onClick={() => void refresh()}>
        {busy ? 'Refreshing…' : 'Refresh from Jira'}
      </Btn>
      {note && <span className="truncate text-xs text-dim">{note}</span>}
      {error && (
        <span role="alert" className="truncate text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  )
}
