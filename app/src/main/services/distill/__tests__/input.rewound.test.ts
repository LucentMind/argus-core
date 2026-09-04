import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { assembleDistillInput } from '../input'
import { buildWorld } from '../world'
import { seedRewoundSession, TAIL_TEXT, LIVE_TEXT } from '../../agent/__tests__/rewoundFixture'

let tmp: string, db: DatabaseSync, caseId: number
const SLUG = 'DI-1'
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-distill-rewound-'))
  db = openDb(path.join(tmp, 'argus.db'))
  caseId = createCase(db, tmp, { slug: SLUG, title: 'd' }).id
  seedRewoundSession(db, tmp, SLUG, caseId)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO findings (case_id, summary, review_state, review_actor, review_reason, created_at)
     VALUES (?, 'judged wrong', 'rejected', 'agent', 'duplicate of #1', ?),
            (?, 'rewound away', 'rejected', 'human', 'rewound', ?)`
  ).run(caseId, now, caseId, now)
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('distill input and rewound turns', () => {
  it('assembleDistillInput.userMessages omits rewound turns', () => {
    const input = assembleDistillInput(db, tmp, SLUG)
    const all = input.userMessages!.flatMap((g) => g.messages).join('\n')
    expect(all).toContain(LIVE_TEXT)
    expect(all).not.toContain(TAIL_TEXT)
  })
  it('buildWorld omits rewound turns', () => {
    const text = JSON.stringify(buildWorld(db, SLUG))
    expect(text).toContain(LIVE_TEXT)
    expect(text).not.toContain(TAIL_TEXT)
  })
  it('findings retracted by a rewind are not in the input; other retractions are', () => {
    const summaries = assembleDistillInput(db, tmp, SLUG).findings.map((f) => f.summary)
    expect(summaries).toContain('judged wrong')
    expect(summaries).not.toContain('rewound away')
  })
})
