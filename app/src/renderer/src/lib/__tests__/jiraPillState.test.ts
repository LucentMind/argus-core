import { describe, it, expect } from 'vitest'
import {
  jiraPillFace,
  summaryHasChanges,
  resultDecayMs,
  COUNTS_DECAY_MS,
  ACK_DECAY_MS
} from '../jiraPillState'
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

describe('jiraPillFace', () => {
  it('shows an absolute clock stamp at rest', () => {
    expect(jiraPillFace({ kind: 'idle' }, SYNCED_AT)).toEqual({
      label: chipStamp(SYNCED_AT),
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
