import type { CaseRecord } from '../../../shared/types'
import { formatSyncAge } from '../../../shared/triage'
import { CircleCheck, TriangleAlert, Minus } from 'lucide-react'

/**
 * Freshness and health of the Jira link, in one footer slot.
 *
 * The icon carries health and the text carries age, because a badge that only ever said "Synced"
 * carried neither. The word "synced" is deliberately absent: the check glyph already says it, and
 * the failure state needs those characters for "failed" — the two states must stay the same width
 * or cards reflow against each other as sync results land.
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
