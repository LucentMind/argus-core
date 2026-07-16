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
})
