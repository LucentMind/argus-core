import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { writeProposal, acceptProposal } from '../proposals'
import { getCaseSummary } from '../distill/summaries'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'case-a', title: 'A case' })
})

describe('accept routing for distill types', () => {
  it('editedContent overrides the staged body', () => {
    const file = writeProposal(home, 'case-a', {
      type: 'reference-edit',
      target: 'edited-reference',
      title: 'Recipe',
      content: 'original'
    })
    // reference-edit lands in <argusHome>/references
    expect(acceptProposal(home, file, { db, editedContent: 'edited text' })).toEqual({
      kind: 'reference',
      name: 'edited-reference.md'
    })
    const written = fs.readFileSync(path.join(home, 'references', 'edited-reference.md'), 'utf8')
    expect(written).toContain('edited text')
    expect(written).not.toContain('original')
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
