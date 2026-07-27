import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { listFindings } from '../findings'

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-findings-'))
}

describe('review-flavored findings', () => {
  it('adds the four nullable columns without touching existing rows', () => {
    const home = tmpHome()
    const db = openDb(path.join(home, 'argus.db'))
    const cols = (db.prepare(`PRAGMA table_info(findings)`).all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols).toEqual(expect.arrayContaining(['layer', 'severity', 'diff_path', 'diff_line']))
  })

  it('derives mode by joining sessions.mode, defaulting a session-less finding to investigation', () => {
    const home = tmpHome()
    const db = openDb(path.join(home, 'argus.db'))
    const kase = createCase(db, home, { slug: 'c1', title: 'c1' })
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO sessions (case_id, mode, created_at, updated_at) VALUES (?, 'review', ?, ?)`
    ).run(kase.id, now, now)
    const sessionId = Number(
      (db.prepare(`SELECT id FROM sessions ORDER BY id DESC LIMIT 1`).get() as { id: number }).id
    )
    db.prepare(
      `INSERT INTO findings (case_id, session_id, summary, review_state, created_at, layer, severity, diff_path, diff_line)
       VALUES (?, ?, 'Inverted guard', 'pending', ?, 'correctness', 'major', 'repo/a.ts', 42)`
    ).run(kase.id, sessionId, now)
    db.prepare(
      `INSERT INTO findings (case_id, session_id, summary, review_state, created_at)
       VALUES (?, NULL, 'Old triage finding', 'pending', ?)`
    ).run(kase.id, now)

    const rows = listFindings(db, home, 'c1')
    const review = rows.find((r) => r.summary === 'Inverted guard')!
    expect(review.mode).toBe('review')
    expect(review.layer).toBe('correctness')
    expect(review.severity).toBe('major')
    expect(review.diffPath).toBe('repo/a.ts')
    expect(review.diffLine).toBe(42)

    const triage = rows.find((r) => r.summary === 'Old triage finding')!
    expect(triage.mode).toBe('investigation')
    expect(triage.layer).toBeNull()
    expect(triage.severity).toBeNull()
  })
})
