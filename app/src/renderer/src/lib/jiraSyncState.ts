import { chipStamp } from './time'
import type { JiraRefreshSummary } from '../../../shared/jira'

export type JiraSyncPhase =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'result'; summary: JiraRefreshSummary }
  | { kind: 'error'; message: string }

/** Anything that would make a user want to look. `commentsError` is deliberately excluded — a
 *  failed comments fetch is not a change to the ticket, and the line reports it either way. */
export function summaryHasChanges(s: JiraRefreshSummary): boolean {
  return (
    s.newAttachments.length > 0 ||
    s.statusChange !== null ||
    s.deletedOnJira.length > 0 ||
    s.newComments > 0
  )
}

/** How long a result holds the line before it decays back to the resting stamp.
 *  Counts get longer than the bare acknowledgement because they carry something to notice;
 *  `up to date` carries nothing to act on and only has to prove the click was not inert.
 *  Both are well clear of a glance — a sub-second window would decay before the eye lands. */
export const COUNTS_DECAY_MS = 10_000
export const ACK_DECAY_MS = 4_000

/**
 * How long `phase` should stay on the line, or `null` for "does not decay".
 *
 * Only a `result` decays. `error` is deliberately sticky until the next refresh attempt: a
 * failure that erased itself would hand the line back to a stale timestamp, and a stale
 * timestamp beside no other signal reads as success — the same reason `jiraSyncLine` ignores
 * `syncedAt` for errors.
 */
export function resultDecayMs(phase: JiraSyncPhase): number | null {
  if (phase.kind !== 'result') return null
  return summaryHasChanges(phase.summary) ? COUNTS_DECAY_MS : ACK_DECAY_MS
}

/** Prose form of a refresh result. */
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
  return parts.length ? parts.join(' · ') : 'Up to date'
}

export interface JiraSyncLine {
  text: string
  tone: 'mute' | 'defect' | 'danger'
}

/**
 * The section's second line, for every state — prose now, not the counts the old fixed-width
 * pill was limited to. Jira became an always-open two-line rail panel on 2026-08-02, so there
 * is room to say what happened and no neighbouring control that a wider line could shove; the
 * popover that used to hold this prose is gone with the pill.
 *
 * `error` deliberately ignores `syncedAt`: a stale-but-known timestamp next to a failure reads
 * as success.
 */
export function jiraSyncLine(phase: JiraSyncPhase, syncedAt: string | null): JiraSyncLine {
  if (phase.kind === 'syncing') return { text: 'Refreshing…', tone: 'mute' }
  if (phase.kind === 'error') return { text: phase.message, tone: 'danger' }
  if (phase.kind === 'result') {
    return {
      text: summarize(phase.summary),
      tone: summaryHasChanges(phase.summary) ? 'defect' : 'mute'
    }
  }
  return {
    text: syncedAt ? `Last refreshed ${chipStamp(syncedAt)}` : 'Never refreshed',
    tone: 'mute'
  }
}
