import { describe, it, expect } from 'vitest'
import { buildFindingTree, isInactiveFinding } from '../findingTree'
import type { FindingRow } from '../observability'

function row(over: Partial<FindingRow>): FindingRow {
  return {
    id: 1,
    caseId: 1,
    sessionId: 1,
    turnId: null,
    summary: 's',
    reviewState: 'pending',
    reviewedAt: null,
    createdAt: 'x',
    layer: null,
    severity: null,
    diffPath: null,
    diffLine: null,
    suggestedChange: null,
    commentUrl: null,
    pushedSha: null,
    commentBody: null,
    headSha: null,
    reviewReason: null,
    reviewActor: null,
    rejectTag: null,
    rejectNote: null,
    mode: 'investigation',
    role: null,
    status: 'confirmed',
    roleSource: null,
    causedBy: null,
    supersededBy: null,
    ...over
  }
}

const ids = (nodes: { row: FindingRow; depth: number }[]): string[] =>
  nodes.map((n) => `${'  '.repeat(n.depth)}#${n.row.id}`)

describe('isInactiveFinding', () => {
  it('is true for rejected, ruled-out, duplicate and superseded findings', () => {
    expect(isInactiveFinding(row({ reviewState: 'rejected' }))).toBe(true)
    expect(isInactiveFinding(row({ role: 'ruled-out' }))).toBe(true)
    expect(isInactiveFinding(row({ role: 'duplicate' }))).toBe(true)
    expect(isInactiveFinding(row({ supersededBy: 9 }))).toBe(true)
    expect(isInactiveFinding(row({ reviewState: 'accepted', role: 'symptom' }))).toBe(false)
  })
  it('treats an undefined supersededBy (a projection row) as not superseded', () => {
    const r = row({}) as Partial<FindingRow> as FindingRow
    delete (r as { supersededBy?: number | null }).supersededBy
    expect(isInactiveFinding(r)).toBe(false)
  })
})

describe('buildFindingTree', () => {
  it('puts a root-cause tree under rootCause with children indented, parents before children', () => {
    const t = buildFindingTree([
      row({ id: 2, role: 'symptom', causedBy: 4 }),
      row({ id: 4, role: 'contributing', causedBy: 6 }),
      row({ id: 6, role: 'root-cause' }),
      row({ id: 3, role: 'symptom', causedBy: 4 })
    ])
    expect(ids(t.rootCause)).toEqual(['#6', '  #4', '    #2', '    #3'])
    expect(t.unexplained).toEqual([])
    expect(t.ruledOut).toEqual([])
  })

  it('lists every active tree whose root is not a root cause under unexplained, by role rank then id', () => {
    const t = buildFindingTree([
      row({ id: 7, role: 'symptom' }),
      row({ id: 5, role: 'contributing' }),
      row({ id: 8, role: null }),
      row({ id: 9, role: 'symptom', causedBy: 5 })
    ])
    expect(ids(t.unexplained)).toEqual(['#5', '  #9', '#7', '#8'])
  })

  it('treats an edge to an inactive or missing parent as no edge, and collapses inactive rows', () => {
    const t = buildFindingTree([
      row({ id: 1, role: 'root-cause', reviewState: 'rejected' }),
      row({ id: 2, role: 'symptom', causedBy: 1 }),
      row({ id: 3, role: 'symptom', causedBy: 99 }),
      row({ id: 4, role: 'duplicate' })
    ])
    expect(ids(t.rootCause)).toEqual([])
    expect(ids(t.unexplained)).toEqual(['#2', '#3'])
    expect(t.ruledOut.map((r) => r.id)).toEqual([4, 1])
  })

  it('never loops on a cycle left in the data and counts pending active findings', () => {
    const t = buildFindingTree([
      row({ id: 1, causedBy: 2 }),
      row({ id: 2, causedBy: 1 }),
      row({ id: 3, reviewState: 'accepted' }),
      row({ id: 4, reviewState: 'rejected' })
    ])
    // Proper roots first; then each cycle member is reached exactly once, the lower id as the root.
    expect(ids(t.unexplained)).toEqual(['#3', '#1', '  #2'])
    expect(t.pending).toBe(2)
  })
})
