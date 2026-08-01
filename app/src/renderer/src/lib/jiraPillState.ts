import { shortStamp } from './time'
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
    ? { label: shortStamp(syncedAt), tone: 'neutral' }
    : { label: 'never', tone: 'stale' }
}
