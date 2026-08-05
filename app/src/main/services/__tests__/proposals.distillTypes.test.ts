import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  writeProposal,
  listProposals,
  listArchivedProposals,
  removePendingProposal,
  rejectProposal
} from '../proposals'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
})

describe('distill proposal types', () => {
  it('writes and lists a recipe proposal with extra frontmatter', () => {
    const file = writeProposal(
      home,
      'case-a',
      {
        type: 'recipe',
        target: 'dlt-cmds',
        title: 'Recipe: drift',
        content: 'ECU resets drift DLT timestamps.'
      },
      { job: '7' }
    )
    const p = listProposals(home).find((x) => x.file === file)!
    expect(p.type).toBe('recipe')
    expect(p.previouslyReviewed).toBeUndefined()
    expect(fs.readFileSync(path.join(home, 'proposals', file), 'utf8')).toContain('job: 7')
  })

  it('refuses to write a memory-append proposal, and hides one already on disk', () => {
    expect(() =>
      writeProposal(home, 'case-a', {
        type: 'memory-append',
        target: 'dlt-timing',
        title: 'Lesson',
        content: 'body'
      })
    ).toThrow(/Invalid proposal type/)
    // A file written before this feature stays on disk but drops out of the pending set —
    // pendingProposalFiles skips any type not in PROPOSAL_TYPES (spec §7, accepted).
    fs.mkdirSync(path.join(home, 'proposals'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'proposals', 'legacy.md'),
      '---\ntype: memory-append\ntarget: dlt-timing\ncase: case-a\ndate: 2026-08-01\ntitle: Lesson\nstatus: pending\n---\nbody'
    )
    expect(listProposals(home).map((p) => p.file)).not.toContain('legacy.md')
    expect(fs.existsSync(path.join(home, 'proposals', 'legacy.md'))).toBe(true)
  })

  it('previously_reviewed frontmatter surfaces as previouslyReviewed', () => {
    const file = writeProposal(
      home,
      'case-a',
      { type: 'case-summary', target: 'case-a', title: 'Summary', content: '# S' },
      { previously_reviewed: 'true' }
    )
    expect(listProposals(home).find((x) => x.file === file)!.previouslyReviewed).toBe(true)
  })

  it('rejects reserved and malformed extraFm keys', () => {
    expect(() =>
      writeProposal(
        home,
        'c',
        { type: 'recipe', target: 't', title: 'x', content: 'y' },
        { type: 'evil' }
      )
    ).toThrow(/reserved/i)
    expect(() =>
      writeProposal(
        home,
        'c',
        { type: 'recipe', target: 't', title: 'x', content: 'y' },
        { 'Bad-Key': 'v' }
      )
    ).toThrow(/key/i)
  })

  it('listArchivedProposals sees rejected items; removePendingProposal deletes without archiving', () => {
    const f1 = writeProposal(home, 'case-a', {
      type: 'recipe',
      target: 't1',
      title: 'a',
      content: 'b'
    })
    rejectProposal(home, f1)
    expect(listArchivedProposals(home)).toEqual([
      { type: 'recipe', target: 't1', caseSlug: 'case-a', title: 'a', status: 'rejected' }
    ])
    const f2 = writeProposal(home, 'case-a', {
      type: 'recipe',
      target: 't2',
      title: 'a',
      content: 'b'
    })
    removePendingProposal(home, f2)
    expect(listProposals(home)).toEqual([])
    expect(listArchivedProposals(home)).toHaveLength(1) // f2 not archived
  })
})
