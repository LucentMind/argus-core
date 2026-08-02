import { describe, it, expect } from 'vitest'
import {
  jiraSyncLine,
  summaryHasChanges,
  resultDecayMs,
  COUNTS_DECAY_MS,
  ACK_DECAY_MS
} from '../jiraSyncState'
import { chipStamp } from '../time'
import type { JiraRefreshSummary } from '../../../../shared/jira'

const SYNCED_AT = '2026-07-31T14:01:00.000Z'

function summary(overrides?: Partial<JiraRefreshSummary>): JiraRefreshSummary {
  return {
    key: 'NAVPOR-10068',
    statusChange: null,
    newAttachments: [],
    deselectedAttachments: [],
    ingestedAttachments: [],
    deletedOnJira: [],
    newComments: 0,
    syncedAt: SYNCED_AT,
    ...overrides
  }
}

describe('jiraSyncLine', () => {
  it('names the resting stamp rather than printing a bare clock', () => {
    expect(jiraSyncLine({ kind: 'idle' }, SYNCED_AT)).toEqual({
      text: `Last refreshed ${chipStamp(SYNCED_AT)}`,
      tone: 'mute'
    })
  })

  it('says never refreshed — not blank — when a linked case has never pulled', () => {
    expect(jiraSyncLine({ kind: 'idle' }, null)).toEqual({
      text: 'Never refreshed',
      tone: 'mute'
    })
  })

  it('says so while syncing', () => {
    expect(jiraSyncLine({ kind: 'syncing' }, SYNCED_AT)).toEqual({
      text: 'Refreshing…',
      tone: 'mute'
    })
  })

  // The pill's face could only fit counts (`+3 · ↑ · 2c`) and sent the prose to a popover. The
  // rail panel has a whole line, so the line says what happened.
  it('reports what changed in prose, not counts', () => {
    const line = jiraSyncLine(
      {
        kind: 'result',
        summary: summary({
          newAttachments: [{}, {}, {}] as JiraRefreshSummary['newAttachments'],
          statusChange: { from: 'Open', to: 'In Progress' },
          newComments: 2
        })
      },
      SYNCED_AT
    )
    expect(line).toEqual({
      text: '3 new attachments · status Open → In Progress · 2 new comments',
      tone: 'defect'
    })
  })

  it('singularises a lone attachment and a lone comment', () => {
    const line = jiraSyncLine(
      {
        kind: 'result',
        summary: summary({
          newAttachments: [{}] as JiraRefreshSummary['newAttachments'],
          newComments: 1
        })
      },
      SYNCED_AT
    )
    expect(line.text).toBe('1 new attachment · 1 new comment')
  })

  it('acknowledges a no-op refresh so a click never looks inert', () => {
    expect(jiraSyncLine({ kind: 'result', summary: summary() }, SYNCED_AT)).toEqual({
      text: 'Up to date',
      tone: 'mute'
    })
  })

  it('counts a deletion noted on Jira as a change, and says it was kept', () => {
    const line = jiraSyncLine(
      {
        kind: 'result',
        summary: summary({ deletedOnJira: [{ attachmentId: '1', filename: 'a.log' }] })
      },
      SYNCED_AT
    )
    expect(line.text).toBe('1 attachment deleted on Jira (kept locally)')
    expect(line.tone).toBe('defect')
  })

  // A failed comments fetch is not a change to the ticket (summaryHasChanges excludes it), but
  // it is still something the line has to admit to.
  it('reports a failed comments fetch without calling it a change', () => {
    const line = jiraSyncLine(
      { kind: 'result', summary: summary({ commentsError: 'HTTP 500' }) },
      SYNCED_AT
    )
    expect(line).toEqual({ text: 'comments fetch failed', tone: 'mute' })
  })

  it('shows the whole failure message and ignores the last good stamp', () => {
    expect(jiraSyncLine({ kind: 'error', message: 'Jira returned 403' }, SYNCED_AT)).toEqual({
      text: 'Jira returned 403',
      tone: 'danger'
    })
  })
})

describe('resultDecayMs', () => {
  it('holds counts longer than a bare acknowledgement', () => {
    const changed = resultDecayMs({
      kind: 'result',
      summary: summary({ statusChange: { from: 'Open', to: 'In Progress' } })
    })
    expect(changed).toBe(COUNTS_DECAY_MS)
    expect(resultDecayMs({ kind: 'result', summary: summary() })).toBe(ACK_DECAY_MS)
    expect(COUNTS_DECAY_MS).toBeGreaterThan(ACK_DECAY_MS)
  })

  it('gives the acknowledgement long enough to be read', () => {
    // Guards the anti-swallow property in the one place it can be asserted without a clock:
    // a sub-second window would decay before the eye lands on the pill.
    expect(ACK_DECAY_MS).toBeGreaterThanOrEqual(3000)
  })

  it('never decays a failure — it is sticky until the next attempt', () => {
    expect(resultDecayMs({ kind: 'error', message: 'boom' })).toBeNull()
  })

  it('has nothing to decay at rest or mid-flight', () => {
    expect(resultDecayMs({ kind: 'idle' })).toBeNull()
    expect(resultDecayMs({ kind: 'syncing' })).toBeNull()
  })
})

describe('summaryHasChanges', () => {
  it('is false for an empty summary', () => {
    expect(summaryHasChanges(summary())).toBe(false)
  })

  it('is true when only the status moved', () => {
    expect(summaryHasChanges(summary({ statusChange: { from: 'A', to: 'B' } }))).toBe(true)
  })
})
