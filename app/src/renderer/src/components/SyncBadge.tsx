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

  const age = c.jiraSyncedAt ? formatSyncAge(c.jiraSyncedAt) : null
  const stamp = c.jiraSyncedAt ? new Date(c.jiraSyncedAt).toLocaleString() : 'never synced'

  if (c.lastSyncError) {
    return (
      <span
        data-testid="sync-badge"
        title={`sync failed — ${c.lastSyncError.code}: ${c.lastSyncError.message} (last success: ${stamp})`}
        className="flex shrink-0 items-center gap-1 text-danger"
      >
        <TriangleAlert size={12} aria-hidden="true" />
        {age ? `failed ${age}` : 'failed'}
      </span>
    )
  }

  if (!age) {
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
      title={`Last synced ${stamp}`}
      className="flex shrink-0 items-center gap-1 text-mute"
    >
      <CircleCheck size={12} aria-hidden="true" />
      {age}
    </span>
  )
}
