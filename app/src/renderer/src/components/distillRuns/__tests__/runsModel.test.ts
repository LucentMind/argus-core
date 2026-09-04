import { describe, it, expect } from 'vitest'
import {
  applyFilters,
  groupByCase,
  runRowLabel,
  phaseLine,
  stamp,
  stripNodes,
  classifyCandidates,
  citeLabel,
  EMPTY_FILTERS
} from '../runsModel'
import type {
  DistillRunListRow,
  DistillRunDetail,
  DistillProgress
} from '../../../../../shared/distill'

/** Mirrors `stamp`'s own local-getter math, so expectations hold regardless of which timezone
 *  runs the test. */
const expectStamp = (iso: string): string => {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const row = (over: Partial<DistillRunListRow>): DistillRunListRow => ({
  id: 1,
  caseSlug: 'a',
  caseTitle: 'Alpha',
  jiraKey: 'NAV-1',
  pipeline: 'v3',
  state: 'done',
  error: null,
  itemCount: 2,
  createdAt: '2026-09-04T13:00:00.000Z',
  finishedAt: '2026-09-04T13:06:00.000Z',
  costUsd: 1.63,
  turnCount: 8,
  toolCallCount: 7,
  promptChars: 100,
  dryRun: false,
  ...over
})
const detail = (over: Partial<DistillRunDetail>): DistillRunDetail => ({
  job: row({}),
  stages: null,
  dropped: [],
  trajectory: null,
  rawOutput: null,
  inputSnapshotChars: 10,
  pipeline: 'v2',
  parsed: {
    dossier: null,
    summaryPresent: false,
    summary: null,
    candidates: null,
    materialized: null
  },
  ...over
})

describe('applyFilters', () => {
  const rows = [
    row({ id: 1, pipeline: 'v3' }),
    row({ id: 2, pipeline: 'v2', dryRun: true, itemCount: null }),
    row({ id: 3, state: 'failed', itemCount: null }),
    row({ id: 4, itemCount: 0 }),
    row({
      id: 5,
      state: 'running',
      itemCount: null,
      caseSlug: 'b',
      caseTitle: 'Beta',
      jiraKey: null
    })
  ]
  it('ORs within a group and ANDs across groups', () => {
    expect(
      applyFilters(rows, { ...EMPTY_FILTERS, pipeline: new Set(['v2']) }).map((r) => r.id)
    ).toEqual([2])
    expect(
      applyFilters(rows, { ...EMPTY_FILTERS, outcome: new Set(['failed', 'zero']) }).map(
        (r) => r.id
      )
    ).toEqual([3, 4])
    expect(
      applyFilters(rows, { ...EMPTY_FILTERS, pipeline: new Set(['v3']), mode: new Set(['dry']) })
    ).toEqual([])
  })
  it('search matches slug, title and jira key, case-insensitively', () => {
    expect(applyFilters(rows, { ...EMPTY_FILTERS, search: 'beta' }).map((r) => r.id)).toEqual([5])
    expect(applyFilters(rows, { ...EMPTY_FILTERS, search: 'nav-1' })).toHaveLength(4)
  })
})

describe('groupByCase', () => {
  it('groups by slug, keeps newest-first inside, orders groups by their newest job', () => {
    const g = groupByCase([
      row({ id: 9, caseSlug: 'b', caseTitle: 'Beta' }),
      row({ id: 5 }),
      row({ id: 3 })
    ])
    expect(g.map((x) => x.slug)).toEqual(['b', 'a'])
    expect(g[1].runs.map((r) => r.id)).toEqual([5, 3])
  })
})

describe('labels', () => {
  it('runRowLabel keeps null itemCount apart from zero', () => {
    expect(runRowLabel(row({ id: 142, dryRun: true, itemCount: null }))).toBe(
      `#142 · v3 · dry · ${expectStamp('2026-09-04T13:06:00.000Z')} · $1.63 · not staged`
    )
    expect(runRowLabel(row({ id: 4, itemCount: 0 }))).toContain('0 staged')
    expect(runRowLabel(row({ id: 3, state: 'failed', itemCount: null, costUsd: null }))).toBe(
      `#3 · v3 · ${expectStamp('2026-09-04T13:06:00.000Z')} · failed`
    )
  })
  it('stamp renders local time, and falls back for missing/unparsable input', () => {
    expect(stamp(null)).toBe('—')
    expect(stamp('garbage')).toBe('garbage')
    expect(stamp('2026-09-04T13:06:00.000Z')).toBe(expectStamp('2026-09-04T13:06:00.000Z'))
  })
  it('phaseLine names the tool call inside the dossier and the materialize target', () => {
    const p = (over: Partial<DistillProgress>): DistillProgress => ({
      jobId: 1,
      caseSlug: 'a',
      at: 'x',
      phase: 'dossier',
      ...over
    })
    expect(phaseLine(p({ phase: 'dossier', toolCalls: 4, detail: 'read_transcript s1' }))).toBe(
      'dossier · 4 tool calls · read_transcript s1'
    )
    expect(phaseLine(p({ phase: 'materialize', detail: 'android-sdk-log-patterns' }))).toBe(
      'materializing android-sdk-log-patterns'
    )
    expect(phaseLine(p({ phase: 'summary+candidates' }))).toBe('summary ‖ candidates')
    expect(phaseLine(p({ phase: 'agent', toolCalls: 2 }))).toBe('agent · 2 tool calls')
  })
  it('citeLabel', () => {
    expect(citeLabel({ finding: 139 })).toBe('finding 139')
    expect(citeLabel({ session: 1, turn: 42 })).toBe('s1:t42')
    expect(citeLabel({ evidence: 'logs/build.txt' })).toBe('ev logs/build.txt')
  })
})

describe('stripNodes', () => {
  it('a finished v3 run: input → dossier → summary/candidates → veto → materialize ×N → validators → staged', () => {
    const d = detail({
      pipeline: 'v3',
      stages: {
        dossier: { promptHash: 'h', promptChars: 1, rawOutput: '', usage: { costUsd: 1.04 } },
        summary: { promptHash: 'h', promptChars: 1, rawOutput: '' },
        candidates: { promptHash: 'h', promptChars: 1, rawOutput: '' },
        materialize: [
          {
            promptHash: 'h',
            promptChars: 1,
            rawOutput: '',
            type: 'reference-edit',
            target: 'x',
            usage: { costUsd: 0.3 }
          }
        ]
      },
      dropped: [
        { type: 'skill-edit', target: 'd', title: 't', reason: 'duplicate' },
        { type: 'reference-edit', target: 'n', title: 't', reason: 'cap' },
        { type: 'reference-edit', target: 'y', title: 't', reason: 'steps-in-reference' }
      ],
      parsed: {
        dossier: null,
        summaryPresent: true,
        summary: null,
        candidates: [{} as never, {} as never, {} as never, {} as never],
        materialized: null
      }
    })
    const nodes = stripNodes(d, null)
    expect(nodes.map((n) => n.id)).toEqual([
      'input',
      'dossier',
      'summary',
      'candidates',
      'veto',
      'materialize',
      'validators',
      'staged'
    ])
    expect(nodes.every((n) => n.state === 'done')).toBe(true)
    expect(nodes[1].stat).toBe('$1.04 · 7 tool calls')
    expect(nodes[3].stat).toBe('$— · 4 out')
    expect(nodes[4].stat).toBe('−2 · duplicate, cap')
    expect(nodes[5].stat).toBe('×1 · $0.30')
    expect(nodes[6].stat).toBe('−1 · steps-in-reference')
    expect(nodes[7].stat).toBe('2 staged')
  })
  it('validators keeps basis drops (only cap is a veto reason, not every non-veto reason)', () => {
    const d = detail({
      pipeline: 'v3',
      stages: {
        dossier: { promptHash: 'h', promptChars: 1, rawOutput: '' },
        summary: { promptHash: 'h', promptChars: 1, rawOutput: '' },
        candidates: { promptHash: 'h', promptChars: 1, rawOutput: '' },
        materialize: [
          {
            promptHash: 'h',
            promptChars: 1,
            rawOutput: '',
            type: 'reference-edit',
            target: 'x'
          }
        ]
      },
      dropped: [{ type: 'reference-edit', target: 'y', title: 't', reason: 'basis' }]
    })
    const n = stripNodes(d, null)
    expect(n.find((x) => x.id === 'validators')!.stat).toBe('−1 · basis')
  })
  it('a dry run marks staged as skipped; a failed stage carries its error; an unreached stage says so', () => {
    const d = detail({
      pipeline: 'v3',
      job: row({ dryRun: true, itemCount: null, state: 'failed' }),
      stages: {
        dossier: { promptHash: 'h', promptChars: 1, rawOutput: '' },
        candidates: { promptHash: 'h', promptChars: 1, rawOutput: '', error: 'boom' }
      }
    })
    const n = stripNodes(d, null)
    expect(n.find((x) => x.id === 'candidates')).toMatchObject({ state: 'error', error: 'boom' })
    expect(n.find((x) => x.id === 'summary')!.state).toBe('not-reached')
    expect(n.find((x) => x.id === 'materialize')!.state).toBe('not-reached')
    expect(n.find((x) => x.id === 'staged')).toMatchObject({
      state: 'skipped',
      stat: 'not staged (dry run)'
    })
  })
  it('an in-flight run derives states from progress: earlier phases done, current running, later pending', () => {
    const d = detail({ pipeline: 'v3', job: row({ state: 'running', itemCount: null }) })
    const n = stripNodes(d, { jobId: 1, caseSlug: 'a', at: 'x', phase: 'materialize', detail: 'x' })
    expect(n.map((x) => x.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'running',
      'pending',
      'pending'
    ])
  })
  it('a v2 run draws input → agent → staged', () => {
    const n = stripNodes(detail({ pipeline: 'v2' }), null)
    expect(n.map((x) => x.id)).toEqual(['input', 'agent', 'staged'])
    expect(n[1].stat).toBe('8 turns · 7 tool calls · $1.63')
  })
  it('a cancelled v2 job renders the agent node as not-reached, not done', () => {
    const d = detail({
      pipeline: 'v2',
      job: row({ state: 'cancelled', itemCount: null })
    })
    const n = stripNodes(d, null)
    expect(n.find((x) => x.id === 'agent')).toMatchObject({
      state: 'not-reached',
      stat: 'cancelled'
    })
    expect(n.find((x) => x.id === 'staged')!.state).toBe('not-reached')
  })
})

describe('classifyCandidates', () => {
  it('joins on type+target and carries the drop reason', () => {
    const c = (type: string, target: string): never => ({ type, target }) as never
    const out = classifyCandidates(
      [c('skill-edit', 'a'), c('reference-edit', 'b')],
      [{ type: 'reference-edit', target: 'b', title: 't', reason: 'duplicate' }]
    )
    expect(out[0].verdict).toEqual({ kind: 'kept' })
    expect(out[1].verdict).toEqual({ kind: 'dropped', reason: 'duplicate' })
  })
})
