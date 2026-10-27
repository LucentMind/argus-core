import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { assembleRcaInput } from '../input'
import { seedRewoundSession, TAIL_TEXT, LIVE_TEXT } from '../../agent/__tests__/rewoundFixture'
import { caseDir } from '../../paths'

let tmp: string, db: DatabaseSync, caseId: number
const SLUG = 'RI-1'
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rca-rewound-'))
  db = openDb(path.join(tmp, 'argus.db'))
  caseId = createCase(db, tmp, { slug: SLUG, title: 'r' }).id
  seedRewoundSession(db, tmp, SLUG, caseId)
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('rca input and rewound turns', () => {
  it('assembleRcaInput.transcripts omits rewound turns', () => {
    const input = assembleRcaInput(db, tmp, SLUG)
    const all = input.transcripts.map((t) => t.text).join('\n')
    expect(all).toContain(LIVE_TEXT)
    expect(all).not.toContain(TAIL_TEXT)
  })
})

describe('rca input and the human reject tag', () => {
  it('assembleRcaInput projects rejectTag and rejectNote onto the finding', () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO findings (case_id, session_id, summary, review_state, created_at, review_actor, reject_tag, reject_note)
           VALUES (?, NULL, 'Tagged', 'rejected', 'x', 'human', 'wrong', 'old build')`
        )
        .run(caseId).lastInsertRowid
    )
    const child = Number(
      db
        .prepare(
          `INSERT INTO findings (case_id, session_id, summary, review_state, created_at, status, role, role_source, caused_by)
           VALUES (?, NULL, 'Linked', 'pending', 'x', 'hypothesis', 'symptom', 'agent', ?)`
        )
        .run(caseId, id).lastInsertRowid
    )
    const old = Number(
      db
        .prepare(
          `INSERT INTO findings (case_id, session_id, summary, review_state, created_at, review_actor, review_reason, superseded_by)
           VALUES (?, NULL, 'Replaced', 'rejected', 'x', 'agent', 'superseded by 1', ?)`
        )
        .run(caseId, id).lastInsertRowid
    )
    fs.appendFileSync(
      path.join(caseDir(tmp, SLUG), 'findings.md'),
      `\n<!-- finding:${old} -->\n## Replaced\n_x_\n\nold body text\n`
    )
    const input = assembleRcaInput(db, tmp, SLUG)
    expect(input.findings.find((f) => f.id === id)).toMatchObject({
      rejectTag: 'wrong',
      rejectNote: 'old build'
    })
    expect(input.findings.find((f) => f.id === child)).toMatchObject({
      status: 'hypothesis',
      roleSource: 'agent',
      causedBy: id,
      supersededBy: null
    })
    expect(input.findings.find((f) => f.id === old)).toMatchObject({ supersededBy: id, body: '' })
  })
})
