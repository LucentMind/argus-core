import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, setCaseStatus } from '../../caseService'
import { applyMemoryWrite } from '../../memory'
import { writeProposal, rejectProposal } from '../../proposals'
import { assembleDistillInput } from '../input'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'case-a', title: 'DLT drift', jiraKey: 'AB-1' })
})

describe('assembleDistillInput', () => {
  it('collects meta, findings with review states, and already-captured knowledge', () => {
    // seed one finding row + body marker
    const caseId = (db.prepare(`SELECT id FROM cases WHERE slug='case-a'`).get() as { id: number })
      .id
    const r = db
      .prepare(
        `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at)
       VALUES (?, NULL, NULL, 'Root cause found', 'accepted', '2026-07-16T00:00:00Z')`
      )
      .run(caseId)
    fs.appendFileSync(
      path.join(home, 'cases', 'case-a', 'findings.md'),
      `\n<!-- finding:${Number(r.lastInsertRowid)} -->\n## Root cause found\n\nClock resync.\n`
    )
    // in-case knowledge: one memory write + one rejected proposal
    applyMemoryWrite(home, 'case-a', { topic: 'dlt-timing', content: 'fact', indexEntry: 'entry' })
    const pf = writeProposal(home, 'case-a', {
      type: 'recipe',
      target: 'dlt-cmds',
      title: 'Cmds',
      content: 'x'
    })
    rejectProposal(home, pf)
    setCaseStatus(db, home, 'case-a', 'closed', 'solved')

    const input = assembleDistillInput(db, home, 'case-a', [
      { name: 'analyze-dlt', description: 'DLT skill' }
    ])
    expect(input.caseMeta).toMatchObject({ slug: 'case-a', jiraKey: 'AB-1', resolution: 'solved' })
    expect(input.findings).toEqual([
      {
        summary: 'Root cause found',
        reviewState: 'accepted',
        body: expect.stringContaining('Clock resync.')
      }
    ])
    expect(input.skillsIndex).toEqual([{ name: 'analyze-dlt', description: 'DLT skill' }])
    expect(input.alreadyCaptured.memoryWrites).toEqual([
      { topic: 'dlt-timing', indexEntry: 'entry' }
    ])
    expect(input.alreadyCaptured.proposals).toEqual([
      { type: 'recipe', target: 'dlt-cmds', title: 'Cmds', state: 'rejected' }
    ])
    expect(input.memoryIndex).toContain('dlt-timing')
  })

  it('throws on unknown case', () => {
    expect(() => assembleDistillInput(db, home, 'nope')).toThrow(/Unknown case/)
  })
})
