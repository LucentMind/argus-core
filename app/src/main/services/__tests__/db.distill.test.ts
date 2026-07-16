import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
})

describe('distill schema', () => {
  it('creates distill_jobs and case_summaries tables', () => {
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at)
       VALUES ('c1', 'queued', '{}', '2026-07-16T00:00:00Z')`
    ).run()
    db.prepare(
      `INSERT INTO case_summaries (case_slug, signature, symptoms, root_cause, fix, keywords, resolution, accepted_at)
       VALUES ('c1', 'sig', 'sym', 'rc', 'fx', '["k"]', 'solved', '2026-07-16T00:00:00Z')`
    ).run()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM distill_jobs`).get()).toEqual({ n: 1 })
  })

  it('case_summaries_fts is queryable', () => {
    db.prepare(
      `INSERT INTO case_summaries_fts (signature, symptoms, root_cause, fix, keywords, case_slug)
       VALUES ('ecu reset drift', '', '', '', '', 'c1')`
    ).run()
    const rows = db
      .prepare(`SELECT case_slug FROM case_summaries_fts WHERE case_summaries_fts MATCH '"ecu"'`)
      .all()
    expect(rows).toEqual([{ case_slug: 'c1' }])
  })
})
