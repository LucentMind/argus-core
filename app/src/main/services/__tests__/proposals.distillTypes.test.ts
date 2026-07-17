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
  it('writes and lists a memory-append proposal with extra frontmatter', () => {
    const file = writeProposal(
      home,
      'case-a',
      {
        type: 'memory-append',
        target: 'dlt-timing',
        title: 'Lesson: drift',
        content: 'ECU resets drift DLT timestamps.'
      },
      { job: '7', index_entry: 'DLT drift after ECU reset' }
    )
    const p = listProposals(home).find((x) => x.file === file)!
    expect(p.type).toBe('memory-append')
    expect(p.previouslyReviewed).toBeUndefined()
    const raw = fs.readFileSync(path.join(home, 'proposals', file), 'utf8')
    expect(raw).toContain('job: 7')
    expect(raw).toContain('index_entry: DLT drift after ECU reset')
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
      type: 'memory-append',
      target: 't1',
      title: 'a',
      content: 'b'
    })
    rejectProposal(home, f1)
    expect(listArchivedProposals(home)).toEqual([
      { type: 'memory-append', target: 't1', caseSlug: 'case-a', title: 'a', status: 'rejected' }
    ])
    const f2 = writeProposal(home, 'case-a', {
      type: 'memory-append',
      target: 't2',
      title: 'a',
      content: 'b'
    })
    removePendingProposal(home, f2)
    expect(listProposals(home)).toEqual([])
    expect(listArchivedProposals(home)).toHaveLength(1) // f2 not archived
  })
})
