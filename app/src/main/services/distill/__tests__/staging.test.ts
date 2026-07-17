import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { writeProposal, listProposals, rejectProposal } from '../../proposals'
import { stageDistillOutput } from '../staging'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'case-a', title: 'A' })
})

describe('stageDistillOutput', () => {
  it('stages all three kinds with job provenance', () => {
    const res = stageDistillOutput(db, home, 'case-a', 7, {
      summary: { signature: 'sig', symptoms: 'sy', rootCause: 'rc', fix: 'fx', keywords: ['k'] },
      memoryAppends: [{ topic: 'dlt-timing', content: 'fact line', indexEntry: 'entry' }],
      proposals: [{ type: 'recipe', target: 'dlt-cmds', title: 'Cmds', content: 'x' }]
    })
    expect(res).toEqual({ staged: 3, droppedDuplicates: 0, supersededRemoved: 0 })
    const ps = listProposals(home)
    expect(ps.map((p) => p.type).sort()).toEqual(['case-summary', 'memory-append', 'recipe'])
    const raw = fs.readFileSync(
      path.join(home, 'proposals', ps.find((p) => p.type === 'case-summary')!.file),
      'utf8'
    )
    expect(raw).toContain('job: 7')
    expect(raw).toContain('summary_json:')
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
      { type: 'memory-append', target: 'old-topic', title: 'old', content: 'x' },
      { job: '3' }
    )
    const res = stageDistillOutput(db, home, 'case-a', 8, {
      proposals: [{ type: 'recipe', target: 'dlt-cmds', title: 'again', content: 'y' }],
      memoryAppends: [{ topic: 'fresh-topic', content: 'new fact' }]
    })
    expect(res.supersededRemoved).toBe(1)
    expect(res.droppedDuplicates).toBe(1)
    const ps = listProposals(home)
    expect(ps.map((p) => p.target).sort()).toEqual(['dlt-cmds', 'fresh-topic']) // user item + new lesson
    expect(ps.find((p) => p.target === 'dlt-cmds')!.title).toBe('user cmds')
  })

  it('marks re-produced previously-reviewed items with the badge flag', () => {
    const f = writeProposal(home, 'case-a', {
      type: 'memory-append',
      target: 'seen-topic',
      title: 't',
      content: 'c'
    })
    rejectProposal(home, f)
    stageDistillOutput(db, home, 'case-a', 9, {
      memoryAppends: [{ topic: 'seen-topic', content: 'c2' }]
    })
    expect(listProposals(home)[0].previouslyReviewed).toBe(true)
  })

  it('normalizes a multi-line indexEntry so the destructive supersede never precedes an unwritable write', () => {
    // job-stamped pending proposal that must be superseded before the new batch lands
    writeProposal(
      home,
      'case-a',
      { type: 'memory-append', target: 'old-topic', title: 'old', content: 'x' },
      { job: '3' }
    )
    const res = stageDistillOutput(db, home, 'case-a', 9, {
      memoryAppends: [{ topic: 'new-topic', content: 'fact', indexEntry: 'line one\nline two' }]
    })
    expect(res.supersededRemoved).toBe(1)
    const ps = listProposals(home)
    const p = ps.find((x) => x.target === 'new-topic')
    expect(p).toBeDefined()
    expect(p!.title).toBe('line one')
    const raw = fs.readFileSync(path.join(home, 'proposals', p!.file), 'utf8')
    expect(raw).toContain('index_entry: line one')
    expect(raw).not.toContain('line two')
  })

  it('validates targets before the destructive supersede step: invalid target throws and leaves old proposals intact', () => {
    // job-stamped pending proposal that must survive the throw below
    writeProposal(
      home,
      'case-a',
      { type: 'memory-append', target: 'old-topic', title: 'old', content: 'x' },
      { job: '3' }
    )
    expect(() =>
      stageDistillOutput(db, home, 'case-a', 9, {
        proposals: [{ type: 'recipe', target: 'has spaces', title: 't', content: 'c' }],
        memoryAppends: [{ topic: 'valid-topic', content: 'fact' }]
      })
    ).toThrow(/invalid target/)
    const ps = listProposals(home)
    expect(ps).toHaveLength(1)
    expect(ps[0].target).toBe('old-topic')
    expect(ps[0].jobId).toBe('3')
  })

  it('rejects a memory topic that is a valid proposal target but not a valid memory topic (uppercase/underscore), before the destructive supersede step', () => {
    // job-stamped pending proposal that must survive the throw below
    writeProposal(
      home,
      'case-a',
      { type: 'memory-append', target: 'old-topic', title: 'old', content: 'x' },
      { job: '3' }
    )
    // 'DLT_Timing' passes isValidProposalTarget (allows uppercase/underscores) but must
    // fail memory's stricter TOPIC_RE — otherwise it stages fine and hard-fails later at
    // accept time in applyMemoryWrite, with no user recourse except reject.
    expect(() =>
      stageDistillOutput(db, home, 'case-a', 9, {
        memoryAppends: [{ topic: 'DLT_Timing', content: 'fact' }]
      })
    ).toThrow(/invalid target/)
    const ps = listProposals(home)
    expect(ps).toHaveLength(1)
    expect(ps[0].target).toBe('old-topic')
    expect(ps[0].jobId).toBe('3')
  })

  it('dedupes intra-batch duplicates (same topic twice in one memoryAppends batch)', () => {
    const res = stageDistillOutput(db, home, 'case-a', 10, {
      memoryAppends: [
        { topic: 'dup-topic', content: 'fact 1' },
        { topic: 'dup-topic', content: 'fact 2' }
      ]
    })
    expect(res.staged).toBe(1)
    expect(res.droppedDuplicates).toBe(1)
    expect(listProposals(home).filter((p) => p.target === 'dup-topic').length).toBe(1)
  })
})
