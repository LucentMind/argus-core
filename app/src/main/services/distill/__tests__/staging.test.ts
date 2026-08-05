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
import { stageDistillOutput } from '../staging'

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
      proposals: [{ type: 'recipe', target: 'dlt-cmds', title: 'Cmds', content: 'x' }]
    })
    expect(res).toEqual({ staged: 2, droppedDuplicates: 0, supersededRemoved: 0 })
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
        { type: 'recipe', target: 'topic-one', title: 'Fact 1', content: 'fact 1' },
        { type: 'recipe', target: 'topic-two', title: 'Fact 2', content: 'fact 2' },
        { type: 'recipe', target: 'dlt-cmds', title: 'Cmds', content: 'x' }
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
        { type: 'recipe', target: 'dlt-cmds', title: 'again', content: 'y' },
        { type: 'recipe', target: 'fresh-topic', title: 'Fresh', content: 'new fact' }
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
      proposals: [{ type: 'recipe', target: 'seen-topic', title: 't2', content: 'c2' }]
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
        { type: 'recipe', target: 'dup-topic', title: 't1', content: 'fact 1' },
        { type: 'recipe', target: 'dup-topic', title: 't2', content: 'fact 2' }
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
