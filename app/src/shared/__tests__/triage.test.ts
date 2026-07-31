import { describe, expect, it } from 'vitest'
import type { CaseRecord } from '../types'
import { deriveActionItems, formatSyncAge, formatSyncRecency, hasUpstreamChange, triageRank } from '../triage'

const NOW = new Date('2026-07-20T12:00:00.000Z')

function mkCase(over: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: 1,
    slug: 'CASE-1',
    title: 'Test case',
    jiraKey: 'PROJ-1',
    jiraSyncedAt: '2026-07-20T11:00:00.000Z',
    jiraDeselected: [],
    jiraStatus: 'Open',
    jiraPriority: 'High',
    jiraCommentCount: 3,
    jiraAttachmentIds: ['a1'],
    reviewBaseline: {
      status: 'Open',
      commentCount: 3,
      attachmentIds: ['a1'],
      capturedAt: '2026-07-20T10:00:00.000Z'
    },
    lastSyncError: null,
    status: 'open',
    resolution: null,
    tags: [],
    createdAt: '2026-07-20T09:00:00.000Z',
    updatedAt: '2026-07-20T11:00:00.000Z',
    actionItems: [],
    ...over
  }
}

describe('deriveActionItems', () => {
  it('returns nothing when upstream matches the baseline', () => {
    expect(deriveActionItems(mkCase(), NOW)).toEqual([])
  })

  it('returns nothing when the baseline is null', () => {
    // Migrated cases must not light up every card at once.
    const items = deriveActionItems(
      mkCase({ reviewBaseline: null, jiraStatus: 'Done', jiraCommentCount: 99 }),
      NOW
    )
    expect(items.filter((i) => i.kind === 'status' || i.kind === 'comments')).toEqual([])
  })

  it('flags a status change', () => {
    const items = deriveActionItems(mkCase({ jiraStatus: 'In Progress' }), NOW)
    expect(items).toContainEqual({
      kind: 'status',
      severity: 'action',
      label: 'status → In Progress'
    })
  })

  it('flags new comments with a count', () => {
    const items = deriveActionItems(mkCase({ jiraCommentCount: 5 }), NOW)
    expect(items).toContainEqual({ kind: 'comments', severity: 'action', label: '2 new comments', count: 2 })
  })

  it('singularises a single new comment', () => {
    const items = deriveActionItems(mkCase({ jiraCommentCount: 4 }), NOW)
    expect(items).toContainEqual({ kind: 'comments', severity: 'action', label: '1 new comment', count: 1 })
  })

  it('ignores a comment count below the baseline (deletions)', () => {
    const items = deriveActionItems(mkCase({ jiraCommentCount: 1 }), NOW)
    expect(items.some((i) => i.kind === 'comments')).toBe(false)
  })

  it('flags attachment ids absent from the baseline', () => {
    const items = deriveActionItems(mkCase({ jiraAttachmentIds: ['a1', 'a2', 'a3'] }), NOW)
    expect(items).toContainEqual({
      kind: 'attachments',
      severity: 'action',
      label: '2 new attachments',
      count: 2
    })
  })

  it('flags a sync error above everything else', () => {
    const items = deriveActionItems(
      mkCase({
        lastSyncError: { code: 'auth', message: 'rejected', at: '2026-07-20T11:00:00.000Z' },
        jiraStatus: 'In Progress'
      }),
      NOW
    )
    expect(items[0]).toEqual({
      kind: 'sync-error',
      severity: 'action',
      label: 'sync failed — auth'
    })
  })

  it('flags staleness past 7 days as info', () => {
    const items = deriveActionItems(mkCase({ jiraSyncedAt: '2026-07-11T12:00:00.000Z' }), NOW)
    expect(items).toContainEqual({ kind: 'stale', severity: 'info', label: 'synced 9d ago' })
  })

  it('does not flag staleness at exactly 7 days', () => {
    const items = deriveActionItems(mkCase({ jiraSyncedAt: '2026-07-13T12:00:00.000Z' }), NOW)
    expect(items.some((i) => i.kind === 'stale')).toBe(false)
  })

  it('never flags staleness on a case with no Jira key', () => {
    const items = deriveActionItems(mkCase({ jiraKey: null, jiraSyncedAt: null }), NOW)
    expect(items.some((i) => i.kind === 'stale')).toBe(false)
  })

  it('orders action items by rank', () => {
    const items = deriveActionItems(
      mkCase({ jiraStatus: 'Done', jiraCommentCount: 4, jiraAttachmentIds: ['a1', 'a2'] }),
      NOW
    )
    expect(items.map((i) => i.kind)).toEqual(['status', 'comments', 'attachments'])
  })
})

describe('hasUpstreamChange', () => {
  it('is false when the only item is info-only', () => {
    // `stale` and `idle` say "we have not looked lately", not "Jira moved".
    expect(hasUpstreamChange([{ kind: 'stale', severity: 'info', label: 'synced 9d ago' }])).toBe(
      false
    )
  })

  it('is false for a case with nothing to report', () => {
    expect(hasUpstreamChange([])).toBe(false)
  })

  it('is true when any item is action-severity, even mixed with info', () => {
    expect(
      hasUpstreamChange([
        { kind: 'comments', severity: 'action', label: '2 new comments' },
        { kind: 'stale', severity: 'info', label: 'synced 9d ago' }
      ])
    ).toBe(true)
  })
})

describe('formatSyncRecency', () => {
  it('reads "synced today" on the day of the sync', () => {
    expect(formatSyncRecency('2026-07-20T02:00:00.000Z', NOW)).toBe('synced today')
  })

  it('counts whole elapsed days', () => {
    expect(formatSyncRecency('2026-07-18T12:00:00.000Z', NOW)).toBe('synced 2d ago')
  })

  it('reads "synced 1d ago", not "1 days"', () => {
    expect(formatSyncRecency('2026-07-19T12:00:00.000Z', NOW)).toBe('synced 1d ago')
  })
})

describe('triageRank', () => {
  it('ranks any action item ahead of info-only', () => {
    const action = triageRank([{ kind: 'comments', severity: 'action', label: 'x' }])
    const info = triageRank([{ kind: 'stale', severity: 'info', label: 'y' }])
    expect(action).toBeLessThan(info)
  })

  it('ranks info ahead of nothing', () => {
    expect(triageRank([{ kind: 'stale', severity: 'info', label: 'y' }])).toBeLessThan(
      triageRank([])
    )
  })

  it('ranks a sync error ahead of new comments', () => {
    expect(triageRank([{ kind: 'sync-error', severity: 'action', label: 'x' }])).toBeLessThan(
      triageRank([{ kind: 'comments', severity: 'action', label: 'y' }])
    )
  })
})

describe('formatSyncAge', () => {
  it('says today inside the first day', () => {
    expect(formatSyncAge('2026-07-08T00:00:00Z', new Date('2026-07-08T18:00:00Z'))).toBe('today')
  })

  it('counts whole days after that', () => {
    expect(formatSyncAge('2026-07-08T00:00:00Z', new Date('2026-07-11T00:00:00Z'))).toBe('3d ago')
  })

  it('is the stem formatSyncRecency prefixes, so the two can never drift', () => {
    const at = '2026-07-08T00:00:00Z'
    const now = new Date('2026-07-11T00:00:00Z')
    expect(formatSyncRecency(at, now)).toBe(`synced ${formatSyncAge(at, now)}`)
  })
})

describe('deriveActionItems counts', () => {
  it('carries the comment delta as a number, not only as prose', () => {
    const c = mkCase({
      jiraCommentCount: 5,
      reviewBaseline: { status: 'Open', commentCount: 2, attachmentIds: [] }
    })
    const item = deriveActionItems(c).find((i) => i.kind === 'comments')
    expect(item?.count).toBe(3)
    expect(item?.label).toBe('3 new comments')
  })

  it('carries the attachment delta as a number', () => {
    const c = mkCase({
      jiraAttachmentIds: ['a', 'b'],
      reviewBaseline: { status: 'Open', commentCount: 0, attachmentIds: ['a'] }
    })
    const item = deriveActionItems(c).find((i) => i.kind === 'attachments')
    expect(item?.count).toBe(1)
    expect(item?.label).toBe('1 new attachment')
  })

  it('leaves count unset on kinds that have no magnitude', () => {
    const c = mkCase({ lastSyncError: { code: 'auth', message: 'nope', at: '2026-07-08T00:00:00Z' } })
    expect(deriveActionItems(c).find((i) => i.kind === 'sync-error')?.count).toBeUndefined()
  })
})
