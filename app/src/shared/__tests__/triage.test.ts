import { describe, expect, it } from 'vitest'
import type { CaseRecord } from '../types'
import { deriveActionItems, formatSyncRecency, hasUpstreamChange, triageRank } from '../triage'

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
    expect(items).toContainEqual({ kind: 'comments', severity: 'action', label: '2 new comments' })
  })

  it('singularises a single new comment', () => {
    const items = deriveActionItems(mkCase({ jiraCommentCount: 4 }), NOW)
    expect(items).toContainEqual({ kind: 'comments', severity: 'action', label: '1 new comment' })
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
      label: '2 new attachments'
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
