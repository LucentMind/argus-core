import { describe, it, expect } from 'vitest'
import type { CaseRecord } from '../../../../shared/types'
import { sortCases, isCaseSortField, isSortDirection } from '../caseSort'

function mk(slug: string, updatedAt: string, lastWorkedAt: string | null): CaseRecord {
  return {
    id: 1,
    slug,
    origin: 'user',
    reviewState: null,
    title: slug,
    jiraKey: null,
    ticketProvider: 'jira',
    jiraSyncedAt: null,
    jiraDeselected: [],
    jiraStatus: null,
    jiraPriority: null,
    jiraCommentCount: null,
    jiraAttachmentIds: [],
    reviewBaseline: null,
    lastSyncError: null,
    status: 'open',
    resolution: null,
    phase: 'open',
    activeMode: 'investigation',
    tags: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt,
    actionItems: [],
    lastWorkedAt,
    archivedAt: null,
    archivePath: null,
    lastOpenedAt: null
  }
}

const slugs = (cs: CaseRecord[]): string[] => cs.map((c) => c.slug)

const D = (day: number): string => `2026-08-0${day}T00:00:00.000Z`

describe('sortCases', () => {
  const a = mk('a', D(1), D(3))
  const b = mk('b', D(3), D(1))
  const c = mk('c', D(2), null)

  it('leaves triage order exactly as main returned it', () => {
    const input = [b, c, a]
    const out = sortCases(input, 'triage', 'desc')
    expect(slugs(out)).toEqual(['b', 'c', 'a'])
    // Pass-through, not a copy-and-reorder — the same reference, so React sees no new array.
    expect(out).toBe(input)
  })

  it('orders by last agent activity, newest first', () => {
    expect(slugs(sortCases([b, c, a], 'worked', 'desc'))).toEqual(['a', 'b', 'c'])
  })

  it('orders by last agent activity, oldest first', () => {
    expect(slugs(sortCases([a, b, c], 'worked', 'asc'))).toEqual(['b', 'a', 'c'])
  })

  it('orders by updatedAt independently of lastWorkedAt', () => {
    // `a` is the most recently WORKED and the least recently UPDATED — if the two keys were
    // wired to the same field this test and the two above could not both pass.
    expect(slugs(sortCases([a, b, c], 'updated', 'desc'))).toEqual(['b', 'c', 'a'])
    expect(slugs(sortCases([a, b, c], 'updated', 'asc'))).toEqual(['a', 'c', 'b'])
  })

  it('sinks never-worked cases to the bottom in BOTH directions', () => {
    expect(slugs(sortCases([a, b, c], 'worked', 'desc')).at(-1)).toBe('c')
    expect(slugs(sortCases([a, b, c], 'worked', 'asc')).at(-1)).toBe('c')
  })

  it('breaks ties on slug so the grid cannot reshuffle between renders', () => {
    const x = mk('x', D(5), D(5))
    const y = mk('y', D(5), D(5))
    expect(slugs(sortCases([y, x], 'worked', 'desc'))).toEqual(['x', 'y'])
    expect(slugs(sortCases([x, y], 'worked', 'asc'))).toEqual(['x', 'y'])
    // Two never-worked cases tie on `null`, which the null branch must also order by slug.
    const p = mk('p', D(5), null)
    const q = mk('q', D(5), null)
    expect(slugs(sortCases([q, p], 'worked', 'desc'))).toEqual(['p', 'q'])
  })

  it('does not mutate the input array', () => {
    const input = [b, c, a]
    sortCases(input, 'worked', 'desc')
    expect(slugs(input)).toEqual(['b', 'c', 'a'])
  })
})

describe('persisted-value guards', () => {
  it('accepts only known fields and directions', () => {
    expect(isCaseSortField('worked')).toBe(true)
    expect(isCaseSortField('triage')).toBe(true)
    expect(isCaseSortField('created')).toBe(false)
    expect(isCaseSortField(null)).toBe(false)
    expect(isSortDirection('asc')).toBe(true)
    expect(isSortDirection('sideways')).toBe(false)
  })
})
