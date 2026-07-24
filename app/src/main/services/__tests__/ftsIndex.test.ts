import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import {
  insertMessageFts,
  deleteMessagesFtsForSession,
  deleteMessagesFtsForCase,
  deleteEvidenceFtsForEvidence,
  deleteEvidenceFtsForCase,
  backfillFtsMaps
} from '../ftsIndex'

let tmp: string, db: DatabaseSync
const n = (sql: string, ...p: unknown[]): number =>
  Number((db.prepare(sql).get(...p) as { n: number }).n)
const plan = (sql: string, ...p: unknown[]): string =>
  (db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...p) as { detail: string }[])
    .map((r) => r.detail)
    .join(' | ')

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-fts-'))
  db = openDb(path.join(tmp, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

// — part 1: FK indexes turn cascade full-scans into index searches —
describe('foreign-key indexes (case-delete cascade)', () => {
  it('every cascaded child delete resolves case_id by index, never a table scan', () => {
    for (const t of ['sessions', 'turns', 'tool_calls', 'findings']) {
      const p = plan(`DELETE FROM ${t} WHERE case_id = ?`, 1)
      expect(p, `${t}: ${p}`).toMatch(/USING (COVERING )?INDEX/)
      expect(p, `${t}: ${p}`).not.toMatch(new RegExp(`SCAN ${t}\\b`))
    }
  })
  it('per-session child deletes resolve session_id by index', () => {
    for (const t of ['turns', 'tool_calls']) {
      expect(plan(`DELETE FROM ${t} WHERE session_id = ?`, 1)).toMatch(/USING (COVERING )?INDEX/)
    }
  })
})

// — part 2: FTS maps stay in sync and deletes leave no orphans —
describe('messages_fts map', () => {
  it('insert populates the map; per-session delete removes both, leaving other sessions', () => {
    insertMessageFts(db, 'alpha bearing', 5, 100, 1, 'user')
    insertMessageFts(db, 'beta bearing', 5, 100, 2, 'assistant')
    insertMessageFts(db, 'gamma bearing', 5, 200, 1, 'user') // different session

    expect(n(`SELECT COUNT(*) AS n FROM messages_fts_map WHERE session_id = ?`, 100)).toBe(2)
    // content is still searchable (search path untouched)
    expect(n(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'bearing'`)).toBe(3)

    deleteMessagesFtsForSession(db, 100)

    expect(n(`SELECT COUNT(*) AS n FROM messages_fts WHERE session_id = ?`, 100)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM messages_fts_map WHERE session_id = ?`, 100)).toBe(0)
    // no orphaned fts rows and the other session survives intact
    expect(n(`SELECT COUNT(*) AS n FROM messages_fts`)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM messages_fts_map`)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM messages_fts WHERE session_id = ?`, 200)).toBe(1)
  })

  it('per-case delete removes every session of the case', () => {
    insertMessageFts(db, 'x', 7, 1, 1, 'user')
    insertMessageFts(db, 'y', 7, 2, 1, 'user')
    insertMessageFts(db, 'z', 9, 3, 1, 'user') // other case
    deleteMessagesFtsForCase(db, 7)
    expect(n(`SELECT COUNT(*) AS n FROM messages_fts`)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM messages_fts_map`)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM messages_fts WHERE case_id = ?`, 9)).toBe(1)
  })
})

describe('evidence_fts map', () => {
  // seed evidence + fts rows the way indexer does (fts row + map row share the rowid)
  function seedEvidence(caseId: number, evidenceId: number, relPath: string, chunks: number): void {
    db.prepare(
      `INSERT INTO evidence (id, case_id, rel_path, sha256, artifact_type, size, created_at)
       VALUES (?, ?, ?, 'h', 'log', 1, '')`
    ).run(evidenceId, caseId, relPath)
    for (let c = 0; c < chunks; c++) {
      const rowid = db
        .prepare(
          `INSERT INTO evidence_fts (content, evidence_id, chunk_index, start_line, end_line)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(`chunk ${c} bearing`, evidenceId, c, 1, 400).lastInsertRowid
      db.prepare(`INSERT INTO evidence_fts_map (fts_rowid, evidence_id) VALUES (?, ?)`).run(
        rowid,
        evidenceId
      )
    }
  }

  beforeEach(() => {
    db.prepare(
      `INSERT INTO cases (id, slug, title, created_at, updated_at) VALUES (1,'A','A','','')`
    ).run()
    db.prepare(
      `INSERT INTO cases (id, slug, title, created_at, updated_at) VALUES (2,'B','B','','')`
    ).run()
  })

  it('deleting one evidence removes exactly its fts rows and map rows', () => {
    seedEvidence(1, 10, 'evidence/a.log', 3)
    seedEvidence(1, 11, 'evidence/b.log', 2)
    deleteEvidenceFtsForEvidence(db, 10)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_fts WHERE evidence_id = ?`, 10)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_fts_map WHERE evidence_id = ?`, 10)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_fts WHERE evidence_id = ?`, 11)).toBe(2)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_fts_map WHERE evidence_id = ?`, 11)).toBe(2)
  })

  it('deleting a case removes fts rows for all its evidence, sparing other cases', () => {
    seedEvidence(1, 10, 'evidence/a.log', 3)
    seedEvidence(1, 11, 'evidence/b.log', 2)
    seedEvidence(2, 20, 'evidence/c.log', 4)
    deleteEvidenceFtsForCase(db, 1)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_fts`)).toBe(4) // only case 2's chunks
    expect(n(`SELECT COUNT(*) AS n FROM evidence_fts_map`)).toBe(4)
  })
})

// — migration: pre-existing FTS rows (no map) get backfilled on open —
describe('backfillFtsMaps', () => {
  it('populates both maps from FTS rows when the maps are empty', () => {
    // simulate a DB written before the fix: fts rows exist, maps do not
    db.prepare(
      `INSERT INTO evidence_fts (content, evidence_id, chunk_index, start_line, end_line) VALUES ('a', 42, 0, 1, 1)`
    ).run()
    insertMessageFts(db, 'm', 3, 30, 1, 'user')
    db.exec(`DELETE FROM evidence_fts_map; DELETE FROM messages_fts_map`)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_fts_map`)).toBe(0)

    backfillFtsMaps(db)

    const em = db.prepare(`SELECT fts_rowid, evidence_id FROM evidence_fts_map`).get() as {
      fts_rowid: number
      evidence_id: number
    }
    expect(em.evidence_id).toBe(42)
    const mm = db.prepare(`SELECT case_id, session_id FROM messages_fts_map`).get() as {
      case_id: number
      session_id: number
    }
    expect(mm).toEqual({ case_id: 3, session_id: 30 })
  })

  it('is idempotent and does not duplicate rows on a healthy DB', () => {
    insertMessageFts(db, 'm', 3, 30, 1, 'user')
    backfillFtsMaps(db) // map already in sync → no-op
    expect(n(`SELECT COUNT(*) AS n FROM messages_fts_map`)).toBe(1)
  })
})
