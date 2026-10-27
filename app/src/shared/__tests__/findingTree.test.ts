import { describe, it, expect } from 'vitest'
import { buildFindingTree, isInactiveFinding, renderFindingTree } from '../findingTree'
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

const H = { rootCause: 'ROOT CAUSE', unexplained: 'UNEXPLAINED', ruledOut: 'RULED OUT' }

describe('renderFindingTree', () => {
  const rows = (): FindingRow[] => [
    row({
      id: 6,
      summary: 'tilesVersion blocked',
      role: 'root-cause',
      reviewState: 'accepted',
      body: 'root body'
    }),
    row({
      id: 4,
      summary: 'Install rejected',
      role: 'contributing',
      causedBy: 6,
      body: 'mid body'
    }),
    row({ id: 2, summary: 'NoRoute offline', role: 'symptom', causedBy: 4, body: 'leaf body' }),
    row({ id: 7, summary: 'Fallback never tried', status: 'hypothesis', body: 'hyp body' }),
    row({
      id: 3,
      summary: 'Server rejects every install',
      role: 'root-cause',
      reviewState: 'rejected',
      reviewActor: 'agent',
      reviewReason: 'superseded by #6',
      supersededBy: 6,
      body: 'old body'
    }),
    row({
      id: 5,
      summary: 'Clock skew',
      role: 'ruled-out',
      reviewState: 'rejected',
      reviewActor: 'human',
      rejectTag: 'wrong',
      rejectNote: 'old build',
      body: 'skew body'
    })
  ]

  it('renders the three sections as the list_findings lines, without bodies', () => {
    expect(renderFindingTree(rows(), { headings: H })).toBe(
      [
        'ROOT CAUSE',
        '#6 · confirmed · accepted · root-cause · tilesVersion blocked',
        '  ↳ #4 · confirmed · pending · contributing · Install rejected',
        '    ↳ #2 · confirmed · pending · symptom · NoRoute offline',
        '',
        'UNEXPLAINED',
        '#7 · hypothesis · pending · no role · Fallback never tried',
        '',
        'RULED OUT',
        '#5 · confirmed · rejected · wrong: old build · ruled-out · Clock skew',
        '#3 · superseded by #6 · root-cause · Server rejects every install'
      ].join('\n')
    )
  })

  it('with bodies, each body follows its line unindented and a superseded row keeps no body', () => {
    const out = renderFindingTree(rows(), { headings: H, bodies: true })
    expect(out).toContain(
      '#6 · confirmed · accepted · root-cause · tilesVersion blocked\nroot body\n\n  ↳ #4 · confirmed · pending · contributing · Install rejected\nmid body\n'
    )
    expect(out).toContain(
      '#5 · confirmed · rejected · wrong: old build · ruled-out · Clock skew\nskew body'
    )
    expect(out).toContain('#3 · superseded by #6 · root-cause · Server rejects every install\n')
    expect(out).not.toContain('old body')
  })

  it('renders a legacy snapshot row (no id, no chain fields) as a flat unexplained line in the old wording', () => {
    const legacy = [{ summary: 'F1', reviewState: 'accepted', role: null, body: 'body1' }]
    expect(renderFindingTree(legacy, { headings: H, bodies: true })).toBe(
      'UNEXPLAINED\naccepted · no role · F1\nbody1\n'
    )
  })

  it('returns the empty string for no rows', () => {
    expect(renderFindingTree([], { headings: H })).toBe('')
  })
})
