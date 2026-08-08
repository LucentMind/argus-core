import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { insertRoutineRun } from '../runs'
import { insertRunItem, attachItemCase } from '../runItems'
import { resolveCaseCandidates } from '../scopeResolver'

let tmp: string
let db: DatabaseSync
const at = (iso: string) => () => new Date(iso)

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'))
  db = openDb(path.join(tmp, 'a.sqlite'))
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const addCase = (slug: string, updatedAt: string, status = 'open', tags: string[] = []): void => {
  db.prepare(
    `INSERT INTO cases (slug, title, status, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(slug, slug, status, JSON.stringify(tags), '2026-01-01T00:00:00.000Z', updatedAt)
}

describe('resolveCaseCandidates', () => {
  it('returns every open case when no filter is given', () => {
    addCase('alpha', '2026-08-01T00:00:00.000Z')
    addCase('beta', '2026-08-02T00:00:00.000Z')
    const out = resolveCaseCandidates(db, 'sweep', { kind: 'cases' })
    expect(out.map((c) => c.slug).sort()).toEqual(['alpha', 'beta'])
  })

  it('filters by status', () => {
    addCase('open-one', '2026-08-01T00:00:00.000Z', 'open')
    addCase('closed-one', '2026-08-01T00:00:00.000Z', 'closed')
    const out = resolveCaseCandidates(db, 'sweep', { kind: 'cases', status: ['closed'] })
    expect(out.map((c) => c.slug)).toEqual(['closed-one'])
  })

  it('filters by tag, matching any of the requested tags', () => {
    addCase('tagged', '2026-08-01T00:00:00.000Z', 'open', ['severity:high'])
    addCase('untagged', '2026-08-01T00:00:00.000Z', 'open', [])
    const out = resolveCaseCandidates(db, 'sweep', { kind: 'cases', tags: ['severity:high'] })
    expect(out.map((c) => c.slug)).toEqual(['tagged'])
  })

  it('carries THIS routine last look at each case, ignoring other routines', () => {
    addCase('alpha', '2026-08-05T00:00:00.000Z')
    const mine = insertRoutineRun(db, 'sweep', 'routine-sweep', 'scheduled', at('2026-08-02T00:00:00.000Z'))
    const mineItem = insertRunItem(db, mine, 'alpha', at('2026-08-02T00:00:00.000Z'))
    attachItemCase(db, mineItem, 'alpha')
    const other = insertRoutineRun(db, 'nightly', 'routine-nightly', 'scheduled', at('2026-08-09T00:00:00.000Z'))
    const otherItem = insertRunItem(db, other, 'alpha', at('2026-08-09T00:00:00.000Z'))
    attachItemCase(db, otherItem, 'alpha')

    const out = resolveCaseCandidates(db, 'sweep', { kind: 'cases' })
    // If the other routine's newer look leaked in, this case would be wrongly skipped later.
    expect(out).toEqual([
      { slug: 'alpha', updatedAt: '2026-08-05T00:00:00.000Z', lastAttemptAt: '2026-08-02T00:00:00.000Z' }
    ])
  })

  it('applies untouchedForDays against updated_at', () => {
    addCase('fresh', '2026-08-08T00:00:00.000Z')
    addCase('stale', '2026-06-01T00:00:00.000Z')
    const out = resolveCaseCandidates(
      db,
      'sweep',
      { kind: 'cases', untouchedForDays: 30 },
      () => new Date('2026-08-08T00:00:00.000Z')
    )
    expect(out.map((c) => c.slug)).toEqual(['stale'])
  })

  it('never returns a case that is itself an unreviewed draft', () => {
    addCase('draft-case', '2026-08-01T00:00:00.000Z')
    db.prepare(`UPDATE cases SET review_state = 'draft' WHERE slug = 'draft-case'`).run()
    expect(resolveCaseCandidates(db, 'sweep', { kind: 'cases' })).toEqual([])
  })
})
