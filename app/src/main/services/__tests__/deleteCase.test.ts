import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, deleteCase, getCase, listCases } from '../caseService'
import { ingestContent } from '../ingest'
import { createSession } from '../agent/sessionStore'
import { readDeletionAudit } from '../deletionAudit'
import { createDetection } from '../packs/detection'
import { samplePackRegistry } from '../packs/__tests__/fixtures'
import { upsertCaseSummary, searchCaseSummaries } from '../distill/summaries'

let tmp: string, argusHome: string, db: DatabaseSync
const detection = createDetection(samplePackRegistry())

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-delc-'))
  argusHome = path.join(tmp, 'home')
  // junction/symlink targets must exist BEFORE createCase for the links to be scaffolded
  fs.mkdirSync(path.join(argusHome, 'skills'), { recursive: true })
  fs.writeFileSync(path.join(argusHome, 'skills', 'keep.md'), 'survivor')
  fs.mkdirSync(path.join(argusHome, 'references'), { recursive: true })
  db = openDb(path.join(argusHome, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function count(table: string, caseId: number): number {
  return Number(
    (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE case_id = ?`).get(caseId) as {
        n: number
      }
    ).n
  )
}

describe('deleteCase', () => {
  it('removes DB rows (cascade + both FTS tables), the case dir, and audits counts', () => {
    const rec = createCase(db, argusHome, { slug: 'NAV-1', title: 'Bearing jumps' })
    const ev = ingestContent(
      db,
      argusHome,
      detection,
      'NAV-1',
      'log.txt',
      'hello\nworld\n',
      'upload'
    )
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO turns (case_id, session_id, turn_index, status, created_at) VALUES (?, ?, 0, 'done', ?)`
    ).run(rec.id, s.id, now)
    db.prepare(
      `INSERT INTO tool_calls (case_id, session_id, tool, args_hash, risk, decision, created_at)
       VALUES (?, ?, 'Read', 'h', 'low', 'allow', ?)`
    ).run(rec.id, s.id, now)
    db.prepare(
      `INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES ('hi', ?, ?, 1, 'user')`
    ).run(rec.id, s.id)
    db.prepare(
      `INSERT INTO findings (case_id, summary, review_state, created_at) VALUES (?, 'root cause', 'pending', ?)`
    ).run(rec.id, now)

    deleteCase(db, argusHome, 'NAV-1')

    expect(getCase(db, 'NAV-1')).toBeNull()
    for (const t of ['evidence', 'sessions', 'turns', 'tool_calls', 'findings']) {
      expect(count(t, rec.id)).toBe(0)
    }
    expect(
      Number(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM evidence_fts WHERE evidence_id = ?`).get(ev.id) as {
            n: number
          }
        ).n
      )
    ).toBe(0)
    expect(
      Number(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE case_id = ?`).get(rec.id) as {
            n: number
          }
        ).n
      )
    ).toBe(0)
    expect(fs.existsSync(path.join(argusHome, 'cases', 'NAV-1'))).toBe(false)
    const audit = readDeletionAudit(argusHome)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ op: 'case.delete', caseSlug: 'NAV-1' })
    expect(audit[0].detail).toMatchObject({
      title: 'Bearing jumps',
      evidence: 1,
      sessions: 1,
      findings: 1
    })
  })

  it('removing the case dir unlinks the .claude junctions without touching their targets', () => {
    createCase(db, argusHome, { slug: 'NAV-1', title: 't' })
    // sanity: the link was scaffolded
    expect(fs.existsSync(path.join(argusHome, 'cases', 'NAV-1', '.claude', 'skills'))).toBe(true)

    deleteCase(db, argusHome, 'NAV-1')

    expect(fs.readFileSync(path.join(argusHome, 'skills', 'keep.md'), 'utf8')).toBe('survivor')
  })

  it('leaves other cases fully intact', () => {
    createCase(db, argusHome, { slug: 'NAV-1', title: 'a' })
    createCase(db, argusHome, { slug: 'NAV-2', title: 'b' })
    ingestContent(db, argusHome, detection, 'NAV-2', 'x.txt', 'x\n', 'upload')

    deleteCase(db, argusHome, 'NAV-1')

    expect(listCases(db).map((c) => c.slug)).toEqual(['NAV-2'])
    expect(fs.existsSync(path.join(argusHome, 'cases', 'NAV-2', 'evidence', 'x.txt'))).toBe(true)
  })

  it('cleans up distill data (case_summaries, case_summaries_fts, distill_jobs) so nothing orphans a dead slug', () => {
    createCase(db, argusHome, { slug: 'NAV-1', title: 'Bearing jumps' })
    upsertCaseSummary(
      db,
      argusHome,
      'NAV-1',
      { signature: 'sig', symptoms: 'sy', rootCause: 'rc', fix: 'fx', keywords: ['k'] },
      'solved',
      '# summary'
    )
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at) VALUES ('NAV-1', 'done', '{}', ?)`
    ).run(new Date().toISOString())

    deleteCase(db, argusHome, 'NAV-1')

    const summaryCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM case_summaries WHERE case_slug = ?`).get('NAV-1') as {
        n: number
      }
    ).n
    const ftsCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM case_summaries_fts WHERE case_slug = ?`)
        .get('NAV-1') as { n: number }
    ).n
    const jobsCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM distill_jobs WHERE case_slug = ?`).get('NAV-1') as {
        n: number
      }
    ).n
    expect(summaryCount).toBe(0)
    expect(ftsCount).toBe(0)
    expect(jobsCount).toBe(0)
    expect(searchCaseSummaries(db, 'sig')).toEqual([])
  })

  it('rejects unknown cases and hostile slugs before touching anything', () => {
    expect(() => deleteCase(db, argusHome, 'NOPE')).toThrow(/unknown case/i)
    expect(() => deleteCase(db, argusHome, '..')).toThrow(/invalid case slug/i)
    expect(() => deleteCase(db, argusHome, '../cases')).toThrow(/invalid case slug/i)
  })
})
