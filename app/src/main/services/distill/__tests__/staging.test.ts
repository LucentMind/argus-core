import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, setCaseStatus } from '../../caseService'
import {
  writeProposal,
  listProposals,
  rejectProposal,
  setProposalsChangedNotifier
} from '../../proposals'
import { stageDistillOutput, RESOLUTION_CAPS } from '../staging'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'case-a', title: 'A' })
})
afterEach(() => {
  setProposalsChangedNotifier(() => {})
})

describe('stageDistillOutput', () => {
  it('stages both kinds with job provenance', () => {
    const res = stageDistillOutput(db, home, 'case-a', 7, {
      summary: { signature: 'sig', symptoms: 'sy', rootCause: 'rc', fix: 'fx', keywords: ['k'] },
      proposals: [
        {
          type: 'recipe',
          target: 'dlt-cmds',
          title: 'Cmds',
          content: 'x',
          basis: 'a well-supported claim about dlt-cmds'
        }
      ]
    })
    expect(res).toEqual({ staged: 2, droppedDuplicates: 0, supersededRemoved: 0, dropped: [] })
    const ps = listProposals(home)
    expect(ps.map((p) => p.type).sort()).toEqual(['case-summary', 'recipe'])
    const raw = fs.readFileSync(
      path.join(home, 'proposals', ps.find((p) => p.type === 'case-summary')!.file),
      'utf8'
    )
    expect(raw).toContain('job: 7')
    expect(raw).toContain('summary_json:')
  })

  it('fires a single change notification for the whole staged batch', () => {
    // one broadcast per staged file meant proposalCounts ran N times per distill run;
    // the whole run (supersede removals + writes) must announce exactly once.
    // Closed/solved so the 3-item cap (Task 14) doesn't drop one of the three proposals below.
    setCaseStatus(db, home, 'case-a', 'closed', 'solved')
    writeProposal(
      home,
      'case-a',
      { type: 'recipe', target: 'old-topic', title: 'old', content: 'x' },
      { job: '3' }
    )
    const cb = vi.fn()
    setProposalsChangedNotifier(cb)
    stageDistillOutput(db, home, 'case-a', 8, {
      summary: { signature: 'sig', symptoms: 'sy', rootCause: 'rc', fix: 'fx', keywords: ['k'] },
      proposals: [
        {
          type: 'recipe',
          target: 'topic-one',
          title: 'Fact 1',
          content: 'fact 1',
          basis: 'evidence supporting fact one'
        },
        {
          type: 'recipe',
          target: 'topic-two',
          title: 'Fact 2',
          content: 'fact 2',
          basis: 'evidence supporting fact two'
        },
        {
          type: 'recipe',
          target: 'dlt-cmds',
          title: 'Cmds',
          content: 'x',
          basis: 'evidence supporting dlt-cmds'
        }
      ]
    })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(listProposals(home)).toHaveLength(4)
  })

  it('supersedes only distiller-produced pending items; drops exact pending duplicates', () => {
    // user-made pending proposal (no job fm) — must survive AND suppress a duplicate
    writeProposal(home, 'case-a', {
      type: 'recipe',
      target: 'dlt-cmds',
      title: 'user cmds',
      content: 'x'
    })
    // old distiller batch (job fm) — must be superseded
    writeProposal(
      home,
      'case-a',
      { type: 'recipe', target: 'old-topic', title: 'old', content: 'x' },
      { job: '3' }
    )
    const res = stageDistillOutput(db, home, 'case-a', 8, {
      proposals: [
        {
          type: 'recipe',
          target: 'dlt-cmds',
          title: 'again',
          content: 'y',
          basis: 'evidence about dlt-cmds again'
        },
        {
          type: 'recipe',
          target: 'fresh-topic',
          title: 'Fresh',
          content: 'new fact',
          basis: 'evidence about the fresh topic'
        }
      ]
    })
    expect(res.supersededRemoved).toBe(1)
    expect(res.droppedDuplicates).toBe(1)
    const ps = listProposals(home)
    expect(ps.map((p) => p.target).sort()).toEqual(['dlt-cmds', 'fresh-topic']) // user item + new lesson
    expect(ps.find((p) => p.target === 'dlt-cmds')!.title).toBe('user cmds')
  })

  it('marks re-produced previously-reviewed items with the badge flag', () => {
    const f = writeProposal(home, 'case-a', {
      type: 'recipe',
      target: 'seen-topic',
      title: 't',
      content: 'c'
    })
    rejectProposal(home, f)
    stageDistillOutput(db, home, 'case-a', 9, {
      proposals: [
        {
          type: 'recipe',
          target: 'seen-topic',
          title: 't2',
          content: 'c2',
          basis: 'evidence about the seen topic'
        }
      ]
    })
    expect(listProposals(home)[0].previouslyReviewed).toBe(true)
  })

  it('validates targets before the destructive supersede step: invalid target throws and leaves old proposals intact', () => {
    // job-stamped pending proposal that must survive the throw below
    writeProposal(
      home,
      'case-a',
      { type: 'recipe', target: 'old-topic', title: 'old', content: 'x' },
      { job: '3' }
    )
    expect(() =>
      stageDistillOutput(db, home, 'case-a', 9, {
        proposals: [
          { type: 'recipe', target: 'has spaces', title: 't', content: 'c' },
          { type: 'recipe', target: 'valid-topic', title: 't', content: 'fact' }
        ]
      })
    ).toThrow(/invalid target/)
    const ps = listProposals(home)
    expect(ps).toHaveLength(1)
    expect(ps[0].target).toBe('old-topic')
    expect(ps[0].jobId).toBe('3')
  })

  it('dedupes intra-batch duplicates (same target twice in one proposals batch)', () => {
    const res = stageDistillOutput(db, home, 'case-a', 10, {
      proposals: [
        {
          type: 'recipe',
          target: 'dup-topic',
          title: 't1',
          content: 'fact 1',
          basis: 'evidence about the dup topic'
        },
        {
          type: 'recipe',
          target: 'dup-topic',
          title: 't2',
          content: 'fact 2',
          basis: 'more evidence about the dup topic'
        }
      ]
    })
    expect(res.staged).toBe(1)
    expect(res.droppedDuplicates).toBe(1)
    expect(listProposals(home).filter((p) => p.target === 'dup-topic').length).toBe(1)
  })

  it('stamps a summary staged from an open case as resolution: open', () => {
    stageDistillOutput(db, home, 'case-a', 7, {
      summary: { signature: 'sig', symptoms: 'sy', rootCause: 'rc', fix: 'fx', keywords: ['k'] }
    })
    const p = listProposals(home).find((x) => x.type === 'case-summary')!
    const raw = fs.readFileSync(path.join(home, 'proposals', p.file), 'utf8')
    expect(raw).toContain('resolution: open')
  })

  it('keeps the real resolution for a closed case', () => {
    setCaseStatus(db, home, 'case-a', 'closed', 'wont-fix')
    stageDistillOutput(db, home, 'case-a', 7, {
      summary: { signature: 'sig', symptoms: 'sy', rootCause: 'rc', fix: 'fx', keywords: ['k'] }
    })
    const p = listProposals(home).find((x) => x.type === 'case-summary')!
    const raw = fs.readFileSync(path.join(home, 'proposals', p.file), 'utf8')
    expect(raw).toContain('resolution: wont-fix')
  })
})

describe('stageDistillOutput — resolution caps, basis gate, prior-reject stamps (Task 14)', () => {
  it('(a) caps a solved case at 3 staged proposals, in model order, recording cap-drops end-first; case-summary stages regardless', () => {
    setCaseStatus(db, home, 'case-a', 'closed', 'solved')
    const proposals = [1, 2, 3, 4, 5].map((n) => ({
      type: 'recipe' as const,
      target: `topic-${n}`,
      title: `T${n}`,
      content: `fact ${n}`,
      basis: `well-supported evidence for topic ${n}`
    }))
    const res = stageDistillOutput(db, home, 'case-a', 20, {
      summary: { signature: 'sig', symptoms: 'sy', rootCause: 'rc', fix: 'fx', keywords: ['k'] },
      proposals
    })
    expect(res.staged).toBe(4) // 3 capped proposals + 1 case-summary (exempt from the cap)
    expect(res.dropped).toEqual([
      { type: 'recipe', target: 'topic-4', title: 'T4', reason: 'cap' },
      { type: 'recipe', target: 'topic-5', title: 'T5', reason: 'cap' }
    ])
    const ps = listProposals(home)
    expect(
      ps
        .filter((p) => p.type === 'recipe')
        .map((p) => p.target)
        .sort()
    ).toEqual(['topic-1', 'topic-2', 'topic-3'])
    expect(ps.some((p) => p.type === 'case-summary')).toBe(true)
  })

  it('(b) drops a short-basis proposal with reason "basis" without counting it against the cap; a surviving basis lands in frontmatter', () => {
    setCaseStatus(db, home, 'case-a', 'closed', 'solved') // cap 3 — plenty of headroom
    const res = stageDistillOutput(db, home, 'case-a', 21, {
      proposals: [
        { type: 'recipe', target: 'short-basis', title: 'Short', content: 'c', basis: 'x' },
        {
          type: 'recipe',
          target: 'good-basis',
          title: 'Good',
          content: 'c',
          basis: 'a well-supported claim goes here'
        }
      ]
    })
    expect(res.dropped).toEqual([
      { type: 'recipe', target: 'short-basis', title: 'Short', reason: 'basis' }
    ])
    expect(res.staged).toBe(1) // the basis-gate drop did not consume a cap slot
    const p = listProposals(home).find((x) => x.target === 'good-basis')!
    const raw = fs.readFileSync(path.join(home, 'proposals', p.file), 'utf8')
    expect(raw).toContain('basis: a well-supported claim goes here')
  })

  it('(b2) a basis drop never counts against the cap even at cap=1: the good-basis proposal survives, no cap drop appears', () => {
    setCaseStatus(db, home, 'case-a', 'closed', 'forwarded') // cap = 1
    const res = stageDistillOutput(db, home, 'case-a', 28, {
      proposals: [
        { type: 'recipe', target: 'short-basis', title: 'Short', content: 'c', basis: 'x' },
        {
          type: 'recipe',
          target: 'good-basis',
          title: 'Good',
          content: 'c',
          basis: 'a well-supported claim goes here'
        }
      ]
    })
    expect(res.dropped).toEqual([
      { type: 'recipe', target: 'short-basis', title: 'Short', reason: 'basis' }
    ])
    expect(res.staged).toBe(1)
    expect(listProposals(home).some((p) => p.target === 'good-basis')).toBe(true)
  })

  it('dedup runs BEFORE the cap slice: a duplicate frees its slot for a later distinct proposal instead of evicting it', () => {
    setCaseStatus(db, home, 'case-a', 'closed', 'wont-fix') // cap = 2
    const res = stageDistillOutput(db, home, 'case-a', 29, {
      proposals: [
        {
          type: 'recipe',
          target: 'dup-target',
          title: 'A1',
          content: 'c1',
          basis: 'evidence supporting dup-target once'
        },
        {
          type: 'recipe',
          target: 'dup-target',
          title: 'A2',
          content: 'c2',
          basis: 'evidence supporting dup-target twice'
        },
        {
          type: 'recipe',
          target: 'distinct-target',
          title: 'B',
          content: 'c3',
          basis: 'evidence supporting the distinct target'
        }
      ]
    })
    expect(res.dropped).toEqual([]) // the duplicate must never register as a 'cap' drop
    expect(res.droppedDuplicates).toBe(1)
    expect(res.staged).toBe(2)
    expect(
      listProposals(home)
        .map((p) => p.target)
        .sort()
    ).toEqual(['distinct-target', 'dup-target'])
  })

  it('(c) stamps a cross-case rejected-target match onto proposal frontmatter, never dropping it', () => {
    createCase(db, home, { slug: 'other-case', title: 'Other' })
    const f = writeProposal(home, 'other-case', {
      type: 'reference-edit',
      target: 'brake-lore',
      title: 'old',
      content: 'x'
    })
    rejectProposal(home, f, { tag: 'overgeneric' })
    const res = stageDistillOutput(db, home, 'case-a', 22, {
      proposals: [
        {
          type: 'reference-edit',
          target: 'brake-lore',
          title: 'New',
          content: 'fresh content',
          basis: 'solid supporting evidence here'
        }
      ]
    })
    expect(res.dropped).toEqual([])
    expect(res.staged).toBe(1)
    const p = listProposals(home).find((x) => x.target === 'brake-lore')!
    const raw = fs.readFileSync(path.join(home, 'proposals', p.file), 'utf8')
    expect(raw).toContain('prior_reject_tag: overgeneric')
    expect(raw).toContain('prior_reject_case: other-case')
  })

  it('(c2) most-recent-wins: when two other cases rejected the same target, stamps the more recently rejected one', () => {
    createCase(db, home, { slug: 'case-old', title: 'Old' })
    createCase(db, home, { slug: 'case-new', title: 'New' })
    const fOld = writeProposal(home, 'case-old', {
      type: 'recipe',
      target: 'shared-topic',
      title: 'old',
      content: 'x'
    })
    rejectProposal(home, fOld, { tag: 'wrong' }, new Date('2026-01-01T00:00:00.000Z'))
    const fNew = writeProposal(home, 'case-new', {
      type: 'recipe',
      target: 'shared-topic',
      title: 'new',
      content: 'y'
    })
    rejectProposal(home, fNew, { tag: 'overgeneric' }, new Date('2026-06-01T00:00:00.000Z'))
    stageDistillOutput(db, home, 'case-a', 23, {
      proposals: [
        {
          type: 'recipe',
          target: 'shared-topic',
          title: 'T',
          content: 'z',
          basis: 'plenty of supporting detail here'
        }
      ]
    })
    const p = listProposals(home).find((x) => x.target === 'shared-topic')!
    const raw = fs.readFileSync(path.join(home, 'proposals', p.file), 'utf8')
    expect(raw).toContain('prior_reject_tag: overgeneric')
    expect(raw).toContain('prior_reject_case: case-new')
  })

  it('does not stamp a prior-reject when the only rejected match is in the SAME case', () => {
    const f = writeProposal(home, 'case-a', {
      type: 'recipe',
      target: 'own-reject-topic',
      title: 'old',
      content: 'x'
    })
    rejectProposal(home, f, { tag: 'wrong' })
    stageDistillOutput(db, home, 'case-a', 24, {
      proposals: [
        {
          type: 'recipe',
          target: 'own-reject-topic',
          title: 'T',
          content: 'z',
          basis: 'plenty of supporting detail here'
        }
      ]
    })
    const p = listProposals(home).find((x) => x.target === 'own-reject-topic')!
    const raw = fs.readFileSync(path.join(home, 'proposals', p.file), 'utf8')
    expect(raw).not.toContain('prior_reject_tag')
    expect(raw).not.toContain('prior_reject_case')
    // The existing same-case mechanism still applies untouched alongside it.
    expect(raw).toContain('previously_reviewed: true')
  })

  it('stages the case-summary regardless of the proposal cap being fully spent', () => {
    setCaseStatus(db, home, 'case-a', 'closed', 'forwarded') // cap = 1
    const res = stageDistillOutput(db, home, 'case-a', 25, {
      summary: { signature: 'sig', symptoms: 'sy', rootCause: 'rc', fix: 'fx', keywords: ['k'] },
      proposals: [
        {
          type: 'recipe',
          target: 'f1',
          title: 'F1',
          content: 'c',
          basis: 'evidence supporting f1 goes here'
        },
        {
          type: 'recipe',
          target: 'f2',
          title: 'F2',
          content: 'c',
          basis: 'evidence supporting f2 goes here'
        }
      ]
    })
    expect(res.staged).toBe(2) // 1 proposal (cap=1) + 1 case-summary
    expect(res.dropped).toEqual([{ type: 'recipe', target: 'f2', title: 'F2', reason: 'cap' }])
    expect(listProposals(home).some((p) => p.type === 'case-summary')).toBe(true)
  })

  it('caps an open case (no recorded resolution) at 2 staged proposals', () => {
    // case-a is left open (default from beforeEach) — open → cap 2.
    const res = stageDistillOutput(db, home, 'case-a', 26, {
      proposals: [
        {
          type: 'recipe',
          target: 'o1',
          title: 'O1',
          content: 'c',
          basis: 'evidence supporting o1 goes here'
        },
        {
          type: 'recipe',
          target: 'o2',
          title: 'O2',
          content: 'c',
          basis: 'evidence supporting o2 goes here'
        },
        {
          type: 'recipe',
          target: 'o3',
          title: 'O3',
          content: 'c',
          basis: 'evidence supporting o3 goes here'
        }
      ]
    })
    expect(res.staged).toBe(2)
    expect(res.dropped).toEqual([{ type: 'recipe', target: 'o3', title: 'O3', reason: 'cap' }])
  })

  it('RESOLUTION_CAPS: covers every known resolution, and an unrecognized one falls back to 1', () => {
    expect(RESOLUTION_CAPS).toEqual({
      solved: 3,
      open: 2,
      'wont-fix': 2,
      forwarded: 1,
      duplicate: 1,
      rejected: 1,
      'not-reproducible': 1
    })
    expect(RESOLUTION_CAPS['made-up-resolution'] ?? 1).toBe(1)
  })
})
