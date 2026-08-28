import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, deleteCase, getCase, listCases, assertCaseDeletable } from '../caseService'
import { ingestContent } from '../ingest'
import { createSession } from '../agent/sessionStore'
import { readDeletionAudit } from '../deletionAudit'
import { insertMessageFts } from '../ftsIndex'
import { createDetection } from '../packs/detection'
import { samplePackRegistry } from '../packs/__tests__/fixtures'
import { upsertCaseSummary, searchCaseSummaries } from '../distill/summaries'
import { CAPTURE_DIR_REL } from '../prompts/capture'
import { createImmediateQueue } from '../ingestQueue'
import { archiveCase } from '../caseArchive'
import { freezeCase } from '../caseFreeze'
import {
  seedArchivableCase,
  cleanupArchiveFixtures,
  seedProposals,
  snapshotProposals
} from './archiveFixtures'

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
      createImmediateQueue(db, argusHome),
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
    insertMessageFts(db, 'hi', rec.id, s.id, 1, 'user')
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
          db
            .prepare(`SELECT COUNT(*) AS n FROM evidence_index_map WHERE evidence_id = ?`)
            .get(ev.id) as {
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
    ingestContent(
      db,
      argusHome,
      detection,
      createImmediateQueue(db, argusHome),
      'NAV-2',
      'x.txt',
      'x\n',
      'upload'
    )

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

  it('cleans up rca_jobs so a confirmed report leaves nothing orphaned on a dead slug', () => {
    // rca_jobs.case_slug is plain TEXT with no FK, so the cases cascade never touches it —
    // and its rows carry the report body (raw_output/template_snapshot), which must not
    // outlive the case any more than the capture directory below does.
    createCase(db, argusHome, { slug: 'NAV-1', title: 'Bearing jumps' })
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO rca_jobs (case_slug, state, input_snapshot, raw_output, template_snapshot, dropped_sections, confirmed_at, created_at)
       VALUES ('NAV-1', 'done', '{}', 'model output', '{}', '{}', ?, ?)`
    ).run(now, now)

    deleteCase(db, argusHome, 'NAV-1')

    const orphans = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM rca_jobs WHERE case_slug NOT IN (SELECT slug FROM cases)`
        )
        .get() as { n: number }
    ).n
    expect(orphans).toBe(0)
  })

  it('removes the case capture directory (.dev-prompts/<slug>) along with the case', () => {
    // Captured systemAppend includes the persona, pack fragments and the agent-access-filtered
    // memory index — a deleted case's prompt text must not survive it on disk.
    createCase(db, argusHome, { slug: 'NAV-1', title: 't' })
    const capDir = path.join(argusHome, CAPTURE_DIR_REL, 'NAV-1')
    fs.mkdirSync(capDir, { recursive: true })
    fs.writeFileSync(path.join(capDir, '1.json'), '{}', 'utf8')

    deleteCase(db, argusHome, 'NAV-1')

    expect(fs.existsSync(capDir)).toBe(false)
  })

  it('does not fail case deletion when there is no capture directory to remove', () => {
    createCase(db, argusHome, { slug: 'NAV-1', title: 't' })
    expect(fs.existsSync(path.join(argusHome, CAPTURE_DIR_REL, 'NAV-1'))).toBe(false)

    expect(() => deleteCase(db, argusHome, 'NAV-1')).not.toThrow()
  })

  it('rejects unknown cases and hostile slugs before touching anything', () => {
    expect(() => deleteCase(db, argusHome, 'NOPE')).toThrow(/unknown case/i)
    expect(() => deleteCase(db, argusHome, '..')).toThrow(/invalid case slug/i)
    expect(() => deleteCase(db, argusHome, '../cases')).toThrow(/invalid case slug/i)
  })
})

describe('deleteCase and the archive bundle', () => {
  afterEach(() => {
    cleanupArchiveFixtures()
  })

  it('removes the bundle when asked', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const res = await archiveCase(db, home, slug, { argusVersion: 'test' })
    expect(fs.existsSync(res.bundlePath)).toBe(true)

    deleteCase(db, home, slug, { deleteArchive: true })

    expect(fs.existsSync(res.bundlePath)).toBe(false)
    expect(getCase(db, slug)).toBeNull()
  })

  it('keeps the bundle by default, and the audit says so', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const res = await archiveCase(db, home, slug, { argusVersion: 'test' })

    deleteCase(db, home, slug)

    // asserting only that the case is gone would pass either way — the point is the bundle
    expect(fs.existsSync(res.bundlePath)).toBe(true)
    expect(getCase(db, slug)).toBeNull()
    const audit = readDeletionAudit(home)
    expect(audit.at(-1)).toMatchObject({ detail: { archiveRetained: true } })
  })

  it('records that the archive was deleted when it was', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    deleteCase(db, home, slug, { deleteArchive: true })
    const audit = readDeletionAudit(home)
    expect(audit.at(-1)).toMatchObject({ detail: { archiveRetained: false } })
  })

  it('refuses to delete a FROZEN case, leaving the row, dir, bundle and audit untouched', async () => {
    // Simulates deleteCase racing an in-flight archiveCase: the archive already produced a
    // verified bundle and is (in the real defect) suspended at an await inside its own
    // transaction, still holding the freeze. A concurrent delete must not be able to pull
    // the case out from under it.
    const { db, home, slug } = await seedArchivableCase()
    const res = await archiveCase(db, home, slug, { argusVersion: 'test' })
    const handle = freezeCase(slug) // archiveCase already released its own; re-freeze to simulate the race
    try {
      expect(() => deleteCase(db, home, slug, { deleteArchive: true })).toThrow(/being archived/i)
    } finally {
      handle.release()
    }

    expect(getCase(db, slug)).not.toBeNull()
    expect(fs.existsSync(path.join(home, 'cases', slug))).toBe(true)
    expect(fs.existsSync(res.bundlePath)).toBe(true)
    expect(readDeletionAudit(home)).toHaveLength(0)
  })

  it('exposes the frozen refusal as ONE rule the IPC handler can check before any side effect', async () => {
    // `cases:delete` stops every live session for the case and unwatches it BEFORE calling
    // deleteCase — both irreversible. Refusing only inside deleteCase therefore killed the
    // user's chats and tore down the watcher and then deleted nothing. The handler now calls
    // this same exported assert first (ordering pinned in main/__tests__/caseArchiveIpc.test.ts).
    const { db, home, slug } = await seedArchivableCase()
    const handle = freezeCase(slug)
    try {
      // Same rule, same message — not a second copy that can drift from deleteCase's.
      const direct = (() => {
        try {
          assertCaseDeletable(slug)
          return null
        } catch (e) {
          return (e as Error).message
        }
      })()
      const viaDelete = (() => {
        try {
          deleteCase(db, home, slug)
          return null
        } catch (e) {
          return (e as Error).message
        }
      })()
      expect(direct).toMatch(/being archived/i)
      expect(viaDelete).toBe(direct)

      // Callable with nothing but a slug, which is what makes "check it FIRST" possible: it
      // needs no db handle and no existing row, so the handler can ask before it touches
      // AgentService or the watcher.
      expect(() => assertCaseDeletable('NO-SUCH-CASE-AT-ALL')).not.toThrow()
    } finally {
      handle.release()
    }
    // and it stops refusing the moment the archive releases
    expect(() => assertCaseDeletable(slug)).not.toThrow()
  })

  it('never touches proposals', async () => {
    const { db, home, slug } = await seedArchivableCase()
    seedProposals(home, slug) // one pending, one archived reject
    const before = snapshotProposals(home)

    deleteCase(db, home, slug, { deleteArchive: true })

    // byte-identical: removing archived rejects makes digestStale's subtraction permanently
    // negative and the global reject digest can never rebuild again
    expect(snapshotProposals(home)).toEqual(before)
  })
})
