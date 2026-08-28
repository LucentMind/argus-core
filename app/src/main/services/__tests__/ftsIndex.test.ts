import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { openDb } from '../db'
import {
  insertMessageFts,
  deleteMessagesFtsForSession,
  deleteMessagesFtsForCase,
  deleteEvidenceFtsForEvidence,
  deleteEvidenceFtsForCase,
  deleteOrphanEvidenceIndex,
  backfillFtsMaps,
  withFtsSavepoint
} from '../ftsIndex'
import { indexEvidenceText, indexEvidenceFile } from '../indexer'
import { createLegacyEvidenceFts } from './legacyFts'

let tmp: string, db: DatabaseSync
const n = (sql: string, ...p: SQLInputValue[]): number =>
  Number((db.prepare(sql).get(...p) as { n: number }).n)
const plan = (sql: string, ...p: SQLInputValue[]): string =>
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
    // These cases are about the LEGACY generation, which db.ts no longer declares — so an
    // "existing install" has to be built explicitly. See __tests__/legacyFts.ts.
    createLegacyEvidenceFts(db)
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

// — the residue class: an evidence_index row with no map row —
//
// The map is the ONLY handle any delete has on an FTS row. A row written without its
// map row is therefore invisible to every map-driven delete in the app: it survives
// crash recovery, comes back as a duplicate chunk_index after the re-index, and is
// never reclaimed, not even when the evidence itself is deleted. Reproduced live by
// SIGKILLing the app mid-index of a 199MB file, landing between the FTS insert and the
// map insert.
//
// indexEvidenceText/indexEvidenceFile write evidence_index + evidence_index_map now
// (Task 2), so the write-path atomicity guard moved here from the legacy tables.
describe('unmapped evidence_index rows', () => {
  const unmapped = (): number =>
    n(`SELECT COUNT(*) AS n FROM evidence_index f
       WHERE NOT EXISTS (SELECT 1 FROM evidence_index_map m WHERE m.fts_rowid = f.rowid)`)

  /** Make the map insert fail, standing in for the crash that landed between the
   *  two statements. Whatever interrupts it, the FTS row must not be left behind. */
  function breakMapInserts(): void {
    db.exec(
      `CREATE TRIGGER argus_test_block_map BEFORE INSERT ON evidence_index_map
       BEGIN SELECT RAISE(ABORT, 'interrupted between the two inserts'); END`
    )
  }

  it('indexEvidenceText leaves NO fts row behind when the map insert fails', () => {
    breakMapInserts()
    expect(() => indexEvidenceText(db, 77, 'alpha\nbravo\ncharlie\n', 2)).toThrow(/interrupted/)
    // The whole pair rolled back: no orphan, so nothing the map-driven delete
    // would miss. (Without the savepoint the fts row survives and is unreclaimable.)
    expect(unmapped()).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_index_map WHERE evidence_id = ?`, 77)).toBe(0)
  })

  it('indexEvidenceFile leaves NO fts row behind when the map insert fails', () => {
    const f = path.join(tmp, 'big.log')
    fs.writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line ${i} bearing`).join('\n') + '\n')
    breakMapInserts()
    expect(() => indexEvidenceFile(db, 78, f, 4)).toThrow(/interrupted/)
    expect(unmapped()).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_index_map WHERE evidence_id = ?`, 78)).toBe(0)
  })

  it('a healthy write still produces one map row per fts row', () => {
    indexEvidenceText(db, 79, 'alpha\nbravo\ncharlie\ndelta\n', 2)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_index_map WHERE evidence_id = ?`, 79)).toBe(2)
    expect(unmapped()).toBe(0)
  })

  it('the atomic write nests inside a caller-held transaction (deleteEvidence uses BEGIN)', () => {
    // node:sqlite rejects a nested BEGIN outright, so the mechanism has to be a
    // SAVEPOINT. This is the regression guard for that choice.
    db.exec('BEGIN')
    expect(() => indexEvidenceText(db, 80, 'alpha\nbravo\n', 1)).not.toThrow()
    db.exec('COMMIT')
    expect(n(`SELECT COUNT(*) AS n FROM evidence_index_map WHERE evidence_id = ?`, 80)).toBe(2)
    expect(unmapped()).toBe(0)
  })

  it('deleteOrphanEvidenceIndex clears residue the map-driven delete cannot see', () => {
    // deleteEvidenceFtsForEvidence resolves rowids THROUGH the map, so it is
    // structurally blind to a row with no map entry — only the global sweep (Task 3's
    // replacement for the old map-independent deleteEvidenceFtsThorough) can reach it.
    // Exercised against evidence_index directly: indexEvidenceText always writes a
    // matched pair, so an orphan there only ever comes from a torn write.
    indexEvidenceText(db, 81, 'healthy bearing\n', 400)
    // pre-fix residue: an index row with no map row
    db.prepare(`INSERT INTO evidence_index (content) VALUES ('orphan bearing')`).run()
    expect(unmapped()).toBe(1)

    deleteEvidenceFtsForEvidence(db, 81) // map-driven: structurally blind to it
    expect(unmapped()).toBe(1)

    expect(deleteOrphanEvidenceIndex(db)).toBe(1)
    expect(unmapped()).toBe(0)
  })
})

// — migration: pre-existing FTS rows (no map) get backfilled on open —
describe('backfillFtsMaps', () => {
  it('populates both maps from FTS rows when the maps are empty', () => {
    // simulate a DB written before the fix: fts rows exist, maps do not
    createLegacyEvidenceFts(db)
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

// — Task 3: deletes clear both index generations, and the orphan sweep is global —
describe('evidence delete across both index generations', () => {
  let seq = 0
  // Each test opens its own db via openTestDb() rather than reusing the shared
  // module-level `db`, so its sqlite file must be closed explicitly before the
  // outer afterEach removes `tmp` -- an open handle survives fs.rmSync as a stray
  // file on Windows and fails it outright with EBUSY.
  const opened: DatabaseSync[] = []

  afterEach(() => {
    for (const d of opened.splice(0)) d.close()
  })

  /** A fresh db, nested inside this test's `tmp` so the outer afterEach's
   *  recursive rmSync still reclaims it. */
  function openTestDb(): DatabaseSync {
    const sub = fs.mkdtempSync(path.join(tmp, 'sub-'))
    const database = openDb(path.join(sub, 'argus.db'))
    opened.push(database)
    return database
  }

  function seedEvidence(database: DatabaseSync): number {
    seq++
    database
      .prepare(
        `INSERT OR IGNORE INTO cases (id, slug, title, created_at, updated_at)
         VALUES (1,'D','D','','')`
      )
      .run()
    const res = database
      .prepare(
        `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, created_at)
         VALUES (1, ?, 'h', 'log', 1, '')`
      )
      .run(`evidence/e${seq}.log`)
    return Number(res.lastInsertRowid)
  }

  it('clears legacy and contentless rows for one evidence id', () => {
    const db = openTestDb()
    createLegacyEvidenceFts(db) // an install that has not migrated yet
    const id = seedEvidence(db)
    // legacy row, written the pre-migration way
    withFtsSavepoint(db, () => {
      const rowid = db
        .prepare(
          `INSERT INTO evidence_fts (content, evidence_id, chunk_index, start_line, end_line)
           VALUES ('legacy text', ?, 0, 1, 1)`
        )
        .run(id).lastInsertRowid
      db.prepare(`INSERT INTO evidence_fts_map (fts_rowid, evidence_id) VALUES (?, ?)`).run(
        rowid,
        id
      )
    })
    indexEvidenceText(db, id, 'new text\n', 400)

    deleteEvidenceFtsForEvidence(db, id)

    expect((db.prepare(`SELECT count(*) AS n FROM evidence_fts`).get() as { n: number }).n).toBe(0)
    expect(
      (db.prepare(`SELECT count(*) AS n FROM evidence_fts_map`).get() as { n: number }).n
    ).toBe(0)
    expect((db.prepare(`SELECT count(*) AS n FROM evidence_index`).get() as { n: number }).n).toBe(
      0
    )
    expect(
      (db.prepare(`SELECT count(*) AS n FROM evidence_index_map`).get() as { n: number }).n
    ).toBe(0)
  })

  it('sweeps an FTS row whose map row is missing', () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    indexEvidenceText(db, id, 'keepme\n', 400)
    // Simulate a torn pre-savepoint write: content with no locator.
    db.prepare(`INSERT INTO evidence_index (content) VALUES ('orphaned')`).run()

    expect(deleteOrphanEvidenceIndex(db)).toBe(1)

    const left = db
      .prepare(`SELECT rowid FROM evidence_index WHERE evidence_index MATCH ?`)
      .all('orphaned OR keepme') as unknown as { rowid: number }[]
    expect(left).toHaveLength(1)
    const mapped = db
      .prepare(`SELECT count(*) AS n FROM evidence_index_map WHERE fts_rowid = ?`)
      .get(left[0].rowid) as { n: number }
    expect(mapped.n).toBe(1)
  })

  it('sweeps nothing when every row is mapped', () => {
    const db = openTestDb()
    indexEvidenceText(db, seedEvidence(db), 'a\nb\nc\n', 1)
    expect(deleteOrphanEvidenceIndex(db)).toBe(0)
  })
})

// — after finalize (and on every fresh install) the legacy tables are simply not there —
//
// db.ts no longer declares evidence_fts / evidence_fts_map, so `db` in these tests is a
// database that has never had them — exactly the shape of a fresh install, and of any
// install the migration has already finalized. Every function here queried them
// unconditionally, which turned each of these calls into "no such table: evidence_fts_map".
// The callers are delete evidence (inside a BEGIN — the throw ROLLBACKs the deletion),
// update evidence content, Rescan, deleteCase and bundle-import rollback.
describe('legacy tables absent (fresh install, or after finalize)', () => {
  function seedIndexedEvidence(evidenceId: number, caseId = 1): void {
    db.prepare(
      `INSERT OR IGNORE INTO cases (id, slug, title, created_at, updated_at)
       VALUES (?, ?, 'L', '', '')`
    ).run(caseId, `L${caseId}`)
    db.prepare(
      `INSERT INTO evidence (id, case_id, rel_path, sha256, artifact_type, size, created_at)
       VALUES (?, ?, ?, 'h', 'log', 1, '')`
    ).run(evidenceId, caseId, `evidence/l${evidenceId}.log`)
    indexEvidenceText(db, evidenceId, 'absent generation text\n', 400)
  }

  it('is the shape under test: neither legacy table exists', () => {
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts'`).get()
    ).toBeUndefined()
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts_map'`).get()
    ).toBeUndefined()
  })

  it('deleteEvidenceFtsForEvidence still clears the current generation', () => {
    seedIndexedEvidence(70)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_index_map WHERE evidence_id = ?`, 70)).toBe(1)

    expect(() => deleteEvidenceFtsForEvidence(db, 70)).not.toThrow()

    expect(n(`SELECT COUNT(*) AS n FROM evidence_index_map WHERE evidence_id = ?`, 70)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_index`)).toBe(0)
  })

  it('deleteEvidenceFtsForEvidence survives being called inside an open transaction', () => {
    // ingest.ts deleteEvidence wraps the whole deletion in BEGIN; a throw in here rolled the
    // evidence row's deletion back with it, so the file could never be removed.
    seedIndexedEvidence(71)
    db.exec(`BEGIN`)
    expect(() => deleteEvidenceFtsForEvidence(db, 71)).not.toThrow()
    db.exec(`COMMIT`)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_index_map WHERE evidence_id = ?`, 71)).toBe(0)
  })

  it('deleteEvidenceFtsForCase still clears the current generation', () => {
    seedIndexedEvidence(72, 2)
    seedIndexedEvidence(73, 3)

    expect(() => deleteEvidenceFtsForCase(db, 2)).not.toThrow()

    expect(n(`SELECT COUNT(*) AS n FROM evidence_index_map WHERE evidence_id = ?`, 72)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_index_map WHERE evidence_id = ?`, 73)).toBe(1)
  })

  it('backfillFtsMaps does not throw, and still backfills the messages map', () => {
    insertMessageFts(db, 'msg', 5, 50, 1, 'user')
    db.exec(`DELETE FROM messages_fts_map`)

    expect(() => backfillFtsMaps(db)).not.toThrow()

    expect(n(`SELECT COUNT(*) AS n FROM messages_fts_map`)).toBe(1)
  })
})

// — index row and map row are deleted together or not at all —
describe('deleteEvidenceFtsForEvidence atomicity', () => {
  it('leaves the map row when the index delete fails, never a map row alone', () => {
    db.prepare(
      `INSERT INTO cases (id, slug, title, created_at, updated_at) VALUES (7,'S','S','','')`
    ).run()
    db.prepare(
      `INSERT INTO evidence (id, case_id, rel_path, sha256, artifact_type, size, created_at)
       VALUES (90, 7, 'evidence/s.log', 'h', 'log', 1, '')`
    ).run()
    indexEvidenceText(db, 90, 'atomic delete text\n', 400)
    expect(n(`SELECT COUNT(*) AS n FROM evidence_index_map WHERE evidence_id = ?`, 90)).toBe(1)

    // Stand in for a crash between the index delete and the map delete. Without one
    // savepoint around both, the index row is already gone when this fires and the map row
    // survives it -- and FTS5 reissues freed rowids, so the next file handed that rowid can
    // never insert its own map row (PRIMARY KEY conflict), permanently.
    db.exec(
      `CREATE TRIGGER argus_test_block_map_delete BEFORE DELETE ON evidence_index_map
       BEGIN SELECT RAISE(ABORT, 'crash before the map delete'); END`
    )

    expect(() => deleteEvidenceFtsForEvidence(db, 90)).toThrow(/crash before the map delete/)

    db.exec(`DROP TRIGGER argus_test_block_map_delete`)
    // Both halves rolled back together: the map row still has its index row.
    const mapped = db
      .prepare(`SELECT fts_rowid FROM evidence_index_map WHERE evidence_id = ?`)
      .get(90) as { fts_rowid: number } | undefined
    expect(mapped).toBeDefined()
    expect(n(`SELECT COUNT(*) AS n FROM evidence_index WHERE rowid = ?`, mapped!.fts_rowid)).toBe(1)
  })
})
