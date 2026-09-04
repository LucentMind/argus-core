import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { assembleRcaInput } from '../input'
import { seedRewoundSession, TAIL_TEXT, LIVE_TEXT } from '../../agent/__tests__/rewoundFixture'

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
