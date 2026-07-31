import type { CaseRecord } from '../../../shared/types'
import { formatSyncAge } from '../../../shared/triage'
import { CircleCheck, TriangleAlert, Minus } from 'lucide-react'

/**
 * Freshness and health of the Jira link, in one footer slot.
 *
 * The icon carries health and the text carries age, because a badge that only ever said "Synced"
 * carried neither. The word "synced" is deliberately absent from the badge text: the check glyph
 * already says it, and the failure state spends those characters on "failed" instead.
 *
 * The failed state is therefore wider than the clean one, on purpose. Nothing here bounds that
 * difference — it is affordable because the status indicator sits in the card's TOP row, leaving
 * the footer with room to spare at three-column width. The widest case (`failed 3d ago` beside
 * both metrics and a CI glyph) is on the live-verification checklist for exactly this reason.
 */
export function SyncBadge({ c }: { c: CaseRecord }): React.JSX.Element | null {
  // No ticket, no sync to report. An empty slot here is correct, not a gap.
  if (!c.jiraKey) return null

  if (c.lastSyncError) {
    // The failure's OWN timestamp, not the last successful sync — setCaseSyncState
    // deliberately leaves jira_synced_at alone on failure, so that field is the last time
    // things worked, not the thing being reported here. A case whose last success was
    // days ago and which broke minutes ago must read the minutes, not the days. The
    // last-success time is still worth knowing, so it moves to the tooltip instead.
    const age = formatSyncAge(c.lastSyncError.at)
    const lastSuccess = c.jiraSyncedAt
      ? `last success: ${new Date(c.jiraSyncedAt).toLocaleString()}`
      : 'never synced'
    return (
      <span
        data-testid="sync-badge"
        title={`sync failed — ${c.lastSyncError.code}: ${c.lastSyncError.message} (${lastSuccess})`}
        className="flex shrink-0 items-center gap-1 text-danger"
      >
        <TriangleAlert size={12} aria-hidden="true" />
        {`failed ${age}`}
      </span>
    )
  }

  if (!c.jiraSyncedAt) {
    return (
      <span
        data-testid="sync-badge"
        title="Linked to Jira but never synced"
        className="flex shrink-0 items-center gap-1 text-mute"
      >
        <Minus size={12} aria-hidden="true" />
        never
      </span>
    )
  }

  return (
    <span
      data-testid="sync-badge"
      title={`Last synced ${new Date(c.jiraSyncedAt).toLocaleString()}`}
      className="flex shrink-0 items-center gap-1 text-mute"
    >
      <CircleCheck size={12} aria-hidden="true" />
      {formatSyncAge(c.jiraSyncedAt)}
    </span>
  )
}
