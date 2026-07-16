import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { writeProposal, acceptProposal, listProposals } from '../proposals'
import { getCaseSummary } from '../distill/summaries'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'case-a', title: 'A case' })
})

describe('accept routing for distill types', () => {
  it('memory-append accept appends to the topic file and maintains the index', () => {
    const file = writeProposal(
      home,
      'case-a',
      {
        type: 'memory-append',
        target: 'dlt-timing',
        title: 'Lesson',
        content: 'ECU resets drift DLT clocks.'
      },
      { index_entry: 'DLT drift after ECU reset' }
    )
    acceptProposal(home, file, { db })
    expect(fs.readFileSync(path.join(home, 'memory', 'dlt-timing.md'), 'utf8')).toContain(
      'ECU resets drift DLT clocks.'
    )
    expect(fs.readFileSync(path.join(home, 'memory', '_index.md'), 'utf8')).toContain('dlt-timing')
    expect(listProposals(home)).toEqual([]) // archived
  })

  it('editedContent overrides the staged body', () => {
    const file = writeProposal(home, 'case-a', {
      type: 'memory-append',
      target: 'edited-topic',
      title: 'Lesson',
      content: 'original'
    })
    acceptProposal(home, file, { db, editedContent: 'edited text' })
    const topic = fs.readFileSync(path.join(home, 'memory', 'edited-topic.md'), 'utf8')
    expect(topic).toContain('edited text')
    expect(topic).not.toContain('original')
  })

  it('case-summary accept upserts the summary row and requires db', () => {
    const sj = JSON.stringify({
      signature: 'sig',
      symptoms: 'sy',
      rootCause: 'rc',
      fix: 'fx',
      keywords: ['k']
    })
    const file = writeProposal(
      home,
      'case-a',
      { type: 'case-summary', target: 'case-a', title: 'Case summary: sig', content: '# body' },
      { summary_json: sj, resolution: 'solved' }
    )
    expect(() => acceptProposal(home, file)).toThrow(/requires db/i)
    acceptProposal(home, file, { db })
    expect(getCaseSummary(db, 'case-a')).toMatchObject({ signature: 'sig', resolution: 'solved' })
  })
})
