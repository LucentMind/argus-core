import { describe, expect, it } from 'vitest'
import { selectJqlItems, selectCaseItems } from '../items'

const item = (key: string, cursorValue: string) => ({ key, cursorValue })

describe('selectJqlItems', () => {
  it('takes everything when the cap is generous', () => {
    const r = selectJqlItems([item('A-1', 't1'), item('A-2', 't2')], new Set(), 10)
    expect(r.selected.map((i) => i.key)).toEqual(['A-1', 'A-2'])
    expect(r.deferred).toBe(0)
  })

  it('caps at maxItems and REPORTS the remainder rather than dropping it silently', () => {
    const forty = Array.from({ length: 40 }, (_, i) => item(`A-${i + 1}`, `t${i + 1}`))
    const r = selectJqlItems(forty, new Set(), 10)
    expect(r.selected).toHaveLength(10)
    expect(r.selected[0].key).toBe('A-1')
    expect(r.selected[9].key).toBe('A-10')
    // The tail is carry-over, not loss: the cursor stops at item 10 so run 2 starts at 11.
    expect(r.deferred).toBe(30)
  })

  it('excludes keys this routine already attempted, which is what makes >= safe', () => {
    // The cursor is INCLUSIVE at the boundary, so the last item of the previous run comes back.
    const r = selectJqlItems([item('A-1', 't1'), item('A-2', 't2')], new Set(['A-1']), 10)
    expect(r.selected.map((i) => i.key)).toEqual(['A-2'])
    expect(r.deferred).toBe(0)
  })

  it('does not count an already-attempted key against the cap', () => {
    const r = selectJqlItems(
      [item('A-1', 't1'), item('A-2', 't2'), item('A-3', 't3')],
      new Set(['A-1']),
      2
    )
    expect(r.selected.map((i) => i.key)).toEqual(['A-2', 'A-3'])
    expect(r.deferred).toBe(0)
  })

  it('carries BOTH items that share one timestamp — the boundary case', () => {
    // Jira timestamps are not unique. Two tickets created in the same minute share `created`.
    // Run 1 takes one of them; run 2 must still see the other, which only works because the
    // query boundary is `>=` and the exclusion is by KEY, not by timestamp.
    const sameMinute = [item('A-1', 't1'), item('A-2', 't1')]
    const run1 = selectJqlItems(sameMinute, new Set(), 1)
    expect(run1.selected.map((i) => i.key)).toEqual(['A-1'])
    const run2 = selectJqlItems(sameMinute, new Set(['A-1']), 1)
    expect(run2.selected.map((i) => i.key)).toEqual(['A-2'])
  })

  it('returns nothing when everything has been attempted', () => {
    const r = selectJqlItems([item('A-1', 't1')], new Set(['A-1']), 10)
    expect(r.selected).toEqual([])
    expect(r.deferred).toBe(0)
  })
})

describe('selectCaseItems', () => {
  const c = (slug: string, updatedAt: string, lastAttemptAt: string | null = null) => ({
    slug,
    updatedAt,
    lastAttemptAt
  })

  it('selects a case this routine has never looked at', () => {
    const r = selectCaseItems([c('alpha', '2026-08-01T00:00:00.000Z')], 10)
    expect(r.selected.map((i) => i.slug)).toEqual(['alpha'])
  })

  it('RE-selects a case modified since the last look — a sweep must revisit', () => {
    const r = selectCaseItems(
      [c('alpha', '2026-08-05T00:00:00.000Z', '2026-08-01T00:00:00.000Z')],
      10
    )
    expect(r.selected.map((i) => i.slug)).toEqual(['alpha'])
  })

  it('skips a case unchanged since the last look', () => {
    const r = selectCaseItems(
      [c('alpha', '2026-08-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z')],
      10
    )
    expect(r.selected).toEqual([])
  })

  it('skips a case looked at in the very same instant it was modified', () => {
    const t = '2026-08-01T00:00:00.000Z'
    expect(selectCaseItems([c('alpha', t, t)], 10).selected).toEqual([])
  })

  it('caps and reports the remainder like the jql path', () => {
    const many = Array.from({ length: 12 }, (_, i) => c(`case-${i}`, '2026-08-01T00:00:00.000Z'))
    const r = selectCaseItems(many, 5)
    expect(r.selected).toHaveLength(5)
    expect(r.deferred).toBe(7)
  })
})
