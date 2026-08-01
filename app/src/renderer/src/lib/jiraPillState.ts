import { chipStamp } from './time'
import type { JiraRefreshSummary } from '../../../shared/jira'

export type JiraPillPhase =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'result'; summary: JiraRefreshSummary }
  | { kind: 'error'; message: string }

export type JiraPillTone = 'neutral' | 'busy' | 'changed' | 'error' | 'stale'

export interface JiraPillFace {
  label: string
  tone: JiraPillTone
}

/** Anything that would make a user want to look at the popover. `commentsError` is
 *  deliberately excluded — a failed comments fetch is not a change to the ticket, and
 *  the popover reports it either way. */
export function summaryHasChanges(s: JiraRefreshSummary): boolean {
  return (
    s.newAttachments.length > 0 ||
    s.statusChange !== null ||
    s.deletedOnJira.length > 0 ||
    s.newComments > 0
  )
}

/** How long a result holds the face before it decays back to the resting stamp.
 *  Counts get longer than the bare acknowledgement because they carry something to notice;
 *  `up to date` carries nothing to act on and only has to prove the click was not inert.
 *  Both are well clear of a glance — a sub-second window would decay before the eye lands. */
export const COUNTS_DECAY_MS = 10_000
export const ACK_DECAY_MS = 4_000

/**
 * How long `phase` should stay on the face, or `null` for "does not decay".
 *
 * Only a `result` decays. `error` is deliberately sticky until the next refresh attempt: a
 * failure that erased itself would hand the face back to a stale timestamp, and a stale
 * timestamp beside no other signal reads as success — the same reason `jiraPillFace` ignores
 * `syncedAt` for errors.
 */
export function resultDecayMs(phase: JiraPillPhase): number | null {
  if (phase.kind !== 'result') return null
  return summaryHasChanges(phase.summary) ? COUNTS_DECAY_MS : ACK_DECAY_MS
}

/**
 * What the pill's face reads, for every state, in one fixed footprint.
 *
 * The face carries counts only; prose lives in the popover, because the whole point of
 * the fixed width is that a landing refresh cannot widen this control and shove the mode
 * switcher sideways. `error` deliberately ignores `syncedAt`: a stale-but-known timestamp
 * next to a failure reads as success.
 */
export function jiraPillFace(phase: JiraPillPhase, syncedAt: string | null): JiraPillFace {
  if (phase.kind === 'syncing') return { label: 'syncing…', tone: 'busy' }
  if (phase.kind === 'error') return { label: 'failed', tone: 'error' }
  if (phase.kind === 'result') {
    const s = phase.summary
    if (!summaryHasChanges(s)) return { label: 'up to date', tone: 'neutral' }
    const parts: string[] = []
    if (s.newAttachments.length) parts.push(`+${s.newAttachments.length}`)
    if (s.statusChange) parts.push('↑')
    if (s.deletedOnJira.length) parts.push(`−${s.deletedOnJira.length}`)
    if (s.newComments) parts.push(`${s.newComments}c`)
    return { label: parts.join(' · '), tone: 'changed' }
  }
  return syncedAt
    ? { label: chipStamp(syncedAt), tone: 'neutral' }
    : { label: 'never', tone: 'stale' }
}
