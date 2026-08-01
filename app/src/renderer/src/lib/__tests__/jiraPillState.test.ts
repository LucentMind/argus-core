import { describe, it, expect } from 'vitest'
import { jiraPillFace, summaryHasChanges } from '../jiraPillState'
import { shortStamp } from '../time'
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

describe('jiraPillFace', () => {
  it('shows an absolute clock stamp at rest', () => {
    expect(jiraPillFace({ kind: 'idle' }, SYNCED_AT)).toEqual({
      label: shortStamp(SYNCED_AT),
      tone: 'neutral'
    })
  })

  it('says never — not blank — when a linked case has never pulled', () => {
    expect(jiraPillFace({ kind: 'idle' }, null)).toEqual({ label: 'never', tone: 'stale' })
  })

  it('is busy while syncing', () => {
    expect(jiraPillFace({ kind: 'syncing' }, SYNCED_AT)).toEqual({
      label: 'syncing…',
      tone: 'busy'
    })
  })

  it('reports counts, not prose, when changes land', () => {
    const face = jiraPillFace(
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
    expect(face).toEqual({ label: '+3 · ↑ · 2c', tone: 'changed' })
  })

  it('acknowledges a no-op refresh so a click never looks inert', () => {
    expect(jiraPillFace({ kind: 'result', summary: summary() }, SYNCED_AT)).toEqual({
      label: 'up to date',
      tone: 'neutral'
    })
  })

  it('counts a deletion noted on Jira as a change', () => {
    const face = jiraPillFace(
      {
        kind: 'result',
        summary: summary({ deletedOnJira: [{ attachmentId: '1', filename: 'a.log' }] })
      },
      SYNCED_AT
    )
    expect(face).toEqual({ label: '−1', tone: 'changed' })
  })

  it('is sticky and red on failure, ignoring the last good stamp', () => {
    expect(jiraPillFace({ kind: 'error', message: 'boom' }, SYNCED_AT)).toEqual({
      label: 'failed',
      tone: 'error'
    })
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
