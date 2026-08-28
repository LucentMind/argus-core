import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import {
  finalizeEvidenceIndexMigration,
  legacyIndexRemaining,
  migrateOneEvidence,
  runEvidenceIndexMigration
} from '../evidenceIndexMigration'
import { backfillFtsMaps, deleteEvidenceFtsForCase, withFtsSavepoint } from '../ftsIndex'
import { deleteEvidenceIndex } from '../indexer'
import { createLegacyEvidenceFts } from './legacyFts'

let tmp: string
let seq = 0
const opened: DatabaseSync[] = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-migration-'))
})

afterEach(() => {
  // Every handle must be closed before the directory goes: on Windows an open sqlite file
  // survives rmSync and fails it outright with EBUSY.
  for (const d of opened.splice(0)) {
    try {
      d.close()
    } catch {
      /* already closed by the test itself */
    }
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** The one database file every open in a test shares — reopening THIS path is what makes a
 *  boot a boot. */
function dbFile(): string {
  return path.join(tmp, 'argus.db')
}

function openTestDb(): DatabaseSync {
  const database = openDb(dbFile())
  opened.push(database)
  return database
}

function seedEvidence(db: DatabaseSync): number {
  seq++
  db.prepare(
    `INSERT OR IGNORE INTO cases (id, slug, title, created_at, updated_at)
     VALUES (1,'M','M','','')`
  ).run()
  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, created_at)
       VALUES (1, ?, 'h', 'log', 1, '')`
    )
    .run(`evidence/m${seq}.log`)
  return Number(res.lastInsertRowid)
}

/**
 * Put this database into the shape an older release left behind: the legacy contentful
 * pair, with rows in it.
 *
 * db.ts no longer declares those tables, so they have to be created explicitly — that
 * removal is the fix for the finalize-every-boot defect, and it means "fresh install" and
 * "existing install" are now genuinely different fixtures. See __tests__/legacyFts.ts.
 */
function seedLegacy(
  db: DatabaseSync,
  evidenceId: number,
  chunks: { text: string; from: number; to: number }[]
): void {
  createLegacyEvidenceFts(db)
  chunks.forEach((c, i) => {
    withFtsSavepoint(db, () => {
      const rowid = db
        .prepare(
          `INSERT INTO evidence_fts (content, evidence_id, chunk_index, start_line, end_line)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(c.text, evidenceId, i, c.from, c.to).lastInsertRowid
      db.prepare(`INSERT INTO evidence_fts_map (fts_rowid, evidence_id) VALUES (?, ?)`).run(
        rowid,
        evidenceId
      )
    })
  })
}

describe('evidence index migration', () => {
  it('moves one evidence row, preserving chunk boundaries exactly', () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [
      { text: 'first chunk text', from: 1, to: 400 },
      { text: 'second chunk text', from: 401, to: 640 }
    ])

    expect(migrateOneEvidence(db)).toBe(id)

    const map = db
      .prepare(
        `SELECT chunk_index, start_line, end_line FROM evidence_index_map
         WHERE evidence_id = ? ORDER BY chunk_index`
      )
      .all(id) as unknown as { chunk_index: number; start_line: number; end_line: number }[]
    expect(map).toEqual([
      { chunk_index: 0, start_line: 1, end_line: 400 },
      { chunk_index: 1, start_line: 401, end_line: 640 }
    ])
  })

  it('carries each chunk’s text across, not just its locator', () => {
    // The text is fetched one chunk at a time rather than selected in bulk (bounded
    // memory: a whole 199 MB evidence file would otherwise be materialised in one array).
    // This is the guard that the per-chunk read is actually wired to the right row.
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [
      { text: 'alpha unique marker', from: 1, to: 10 },
      { text: 'bravo unique marker', from: 11, to: 20 },
      { text: 'charlie unique marker', from: 21, to: 30 }
    ])

    migrateOneEvidence(db)

    for (const [term, chunkIndex] of [
      ['alpha', 0],
      ['bravo', 1],
      ['charlie', 2]
    ] as const) {
      const hit = db
        .prepare(
          `SELECT m.chunk_index AS chunkIndex FROM evidence_index
           JOIN evidence_index_map m ON m.fts_rowid = evidence_index.rowid
           WHERE evidence_index MATCH ?`
        )
        .get(term) as { chunkIndex: number } | undefined
      expect(hit?.chunkIndex).toBe(chunkIndex)
    }
  })

  it('leaves the legacy table empty for the migrated row', () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [{ text: 'only chunk', from: 1, to: 10 }])
    migrateOneEvidence(db)
    expect(
      (
        db.prepare(`SELECT count(*) AS n FROM evidence_fts_map WHERE evidence_id = ?`).get(id) as {
          n: number
        }
      ).n
    ).toBe(0)
    expect((db.prepare(`SELECT count(*) AS n FROM evidence_fts`).get() as { n: number }).n).toBe(0)
  })

  it('keeps the migrated text searchable', () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [{ text: 'connection refused by peer', from: 1, to: 1 }])
    migrateOneEvidence(db)
    const hit = db
      .prepare(`SELECT rowid FROM evidence_index WHERE evidence_index MATCH ?`)
      .all('"connection refused"') as unknown as { rowid: number }[]
    expect(hit).toHaveLength(1)
  })

  it('returns null and moves nothing when the legacy table is empty', () => {
    const db = openTestDb()
    expect(migrateOneEvidence(db)).toBeNull()
    expect(legacyIndexRemaining(db)).toBe(0)
  })

  it('is resumable: a partial run leaves the remainder to a later run', async () => {
    const db = openTestDb()
    const ids = [seedEvidence(db), seedEvidence(db), seedEvidence(db)]
    for (const id of ids) seedLegacy(db, id, [{ text: `text for ${id}`, from: 1, to: 5 }])

    let seen = 0
    await runEvidenceIndexMigration(db, { shouldStop: () => ++seen > 1 })
    expect(legacyIndexRemaining(db)).toBe(2)

    await runEvidenceIndexMigration(db)
    expect(legacyIndexRemaining(db)).toBe(0)
    expect(
      (db.prepare(`SELECT count(*) AS n FROM evidence_index_map`).get() as { n: number }).n
    ).toBe(3)
  })

  it('reports progress against the starting total', async () => {
    const db = openTestDb()
    for (const id of [seedEvidence(db), seedEvidence(db)])
      seedLegacy(db, id, [{ text: 'x', from: 1, to: 1 }])
    const seen: [number, number][] = []
    await runEvidenceIndexMigration(db, { onProgress: (d, t) => seen.push([d, t]) })
    expect(seen).toEqual([
      [1, 2],
      [2, 2]
    ])
  })

  // Load-bearing: each evidence row moves inside ONE withFtsSavepoint. A torn migration
  // would leave some chunks in evidence_index and the rest still in evidence_fts, which
  // makes search return the same file twice with different line ranges -- and any
  // evidence_index_map row left unpaired by a crash is exactly what the boot orphan
  // sweep (deleteOrphanEvidenceIndex) would then delete.
  it('rolls back the whole row when a chunk in the middle fails, leaving the legacy row untouched', () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [
      { text: 'chunk zero', from: 1, to: 10 },
      { text: 'chunk one', from: 11, to: 20 },
      { text: 'chunk two', from: 21, to: 30 }
    ])
    // Fail the third chunk's map insert, standing in for a crash mid-row.
    db.exec(
      `CREATE TRIGGER argus_test_block_third_map BEFORE INSERT ON evidence_index_map
       WHEN (SELECT COUNT(*) FROM evidence_index_map) = 2
       BEGIN SELECT RAISE(ABORT, 'interrupted mid-row'); END`
    )

    expect(() => migrateOneEvidence(db)).toThrow(/interrupted/)

    expect(
      (
        db.prepare(`SELECT count(*) AS n FROM evidence_fts WHERE evidence_id = ?`).get(id) as {
          n: number
        }
      ).n
    ).toBe(3)
    expect(
      (
        db
          .prepare(`SELECT count(*) AS n FROM evidence_index_map WHERE evidence_id = ?`)
          .get(id) as { n: number }
      ).n
    ).toBe(0)
  })
})

describe('finalize', () => {
  it('refuses to drop anything while legacy rows remain', () => {
    const db = openTestDb()
    seedLegacy(db, seedEvidence(db), [{ text: 'still here', from: 1, to: 1 }])
    expect(finalizeEvidenceIndexMigration(db)).toBe(false)
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts'`).get()
    ).toBeTruthy()
  })

  it('drops both legacy tables once nothing is left', () => {
    const db = openTestDb()
    seedLegacy(db, seedEvidence(db), [{ text: 'move me', from: 1, to: 1 }])
    // Drain via migrateOneEvidence directly (not runEvidenceIndexMigration, which already
    // auto-finalizes once it drains) so this exercises finalizeEvidenceIndexMigration's own
    // true-returning path in isolation.
    while (migrateOneEvidence(db) !== null) {
      /* drain */
    }
    expect(finalizeEvidenceIndexMigration(db)).toBe(true)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts'`).get()).toBe(
      undefined
    )
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts_map'`).get()).toBe(
      undefined
    )
  })

  it('does nothing at all on a database that never had the legacy tables', () => {
    // A fresh install. There is no migration to complete and nothing to reclaim, so
    // finalize must not DROP, must not VACUUM, and must not throw.
    const db = openTestDb()
    const sql = recordExec(db)
    expect(finalizeEvidenceIndexMigration(db)).toBe(false)
    expect(sql.filter(isVacuum)).toHaveLength(0)
  })

  it('still cleans up when a crash left only one of the two legacy tables', () => {
    // The two DROPs are separate statements; a crash between them leaves evidence_fts_map
    // behind with no content table to join. Readers treat that as "legacy gone" (they
    // would throw on the missing half); finalize is the one caller that must still fire,
    // or the residue is never reclaimed.
    const db = openTestDb()
    seedLegacy(db, seedEvidence(db), [{ text: 'half dropped', from: 1, to: 1 }])
    while (migrateOneEvidence(db) !== null) {
      /* drain */
    }
    db.exec(`DROP TABLE evidence_fts`)

    expect(finalizeEvidenceIndexMigration(db)).toBe(true)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts_map'`).get()).toBe(
      undefined
    )
  })

  it('leaves the migrated content searchable afterwards', async () => {
    const db = openTestDb()
    seedLegacy(db, seedEvidence(db), [{ text: 'survivor token', from: 1, to: 1 }])
    await runEvidenceIndexMigration(db)
    finalizeEvidenceIndexMigration(db)
    const hits = db
      .prepare(`SELECT rowid FROM evidence_index WHERE evidence_index MATCH ?`)
      .all('survivor') as unknown as { rowid: number }[]
    expect(hits).toHaveLength(1)
  })

  it('enables incremental auto_vacuum', async () => {
    const db = openTestDb()
    // auto_vacuum only changes across a VACUUM, so finalize has to actually run -- which
    // means this database needs legacy tables to drop.
    seedLegacy(db, seedEvidence(db), [{ text: 'move me', from: 1, to: 1 }])
    await runEvidenceIndexMigration(db)
    const mode = db.prepare(`PRAGMA auto_vacuum`).get() as { auto_vacuum: number }
    expect(mode.auto_vacuum).toBe(2) // 2 = INCREMENTAL
  })
})

// — what actually happens at startup —
//
// Nothing above this point describes a boot: they all hold ONE handle open for the whole
// test. The defect this block exists to catch lived precisely in the gap between those two
// things. finalize's "have I already run?" question is "do the legacy tables exist?", and
// db.ts's schema -- which openDb execs on EVERY open -- used to declare both of them. So
// the next time the process opened the file, the tables finalize had just dropped came
// back, empty; the guard passed again; zero rows remained; and DROP/DROP/PRAGMA/VACUUM ran
// again. On the multi-gigabyte installation this migration targets that is a full rewrite
// of the database at every single launch, forever. A single-handle test cannot see it,
// because openDb never runs a second time.
//
// So each "boot" here closes the handle and reopens the same path through the real openDb,
// then makes the call main/index.ts makes. And the assertions are on the SQL actually
// issued, not on return values: finalize returning false is not the same fact as VACUUM
// not running.
describe('boots: the same database file, closed and reopened through openDb', () => {
  interface Boot {
    db: DatabaseSync
    sql: string[]
  }

  /** One application start: open the file, then run the migration exactly as
   *  main/index.ts does. The caller closes `db` to end the boot. */
  async function boot(): Promise<Boot> {
    const db = openDb(dbFile())
    opened.push(db)
    const sql = recordExec(db)
    await runEvidenceIndexMigration(db)
    return { db, sql }
  }

  function tableNames(db: DatabaseSync): string[] {
    return (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
        name: string
      }[]
    ).map((r) => r.name)
  }

  /** Build the file an older release would have left: legacy tables, with rows. */
  function seedExistingInstall(): number {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [
      { text: 'boot marker alpha', from: 1, to: 10 },
      { text: 'boot marker bravo', from: 11, to: 20 }
    ])
    db.close()
    return id
  }

  it('fresh install: two boots, and VACUUM is never issued', async () => {
    const first = await boot()
    expect(first.sql.filter(isVacuum)).toHaveLength(0)
    expect(first.sql.filter(isLegacyDrop)).toHaveLength(0)
    // openDb must not have created them in the first place
    expect(tableNames(first.db)).not.toContain('evidence_fts')
    expect(tableNames(first.db)).not.toContain('evidence_fts_map')
    first.db.close()

    const second = await boot()
    expect(second.sql.filter(isVacuum)).toHaveLength(0)
    expect(second.sql.filter(isLegacyDrop)).toHaveLength(0)
    expect(tableNames(second.db)).not.toContain('evidence_fts')
    second.db.close()
  })

  it('existing install: boot 1 migrates and VACUUMs once, boot 2 does neither', async () => {
    seedExistingInstall()

    const first = await boot()
    expect(first.sql.filter(isVacuum)).toHaveLength(1)
    expect(first.sql.filter(isLegacyDrop)).toHaveLength(2)
    expect(tableNames(first.db)).not.toContain('evidence_fts')
    // the content moved rather than being discarded
    expect(matchCount(first.db, 'bravo')).toBe(1)
    first.db.close()

    const second = await boot()
    // This is the assertion the shipped code failed: openDb had recreated both tables, so
    // finalize dropped and VACUUMed all over again.
    expect(second.sql.filter(isVacuum)).toHaveLength(0)
    expect(second.sql.filter(isLegacyDrop)).toHaveLength(0)
    expect(tableNames(second.db)).not.toContain('evidence_fts')
    expect(tableNames(second.db)).not.toContain('evidence_fts_map')
    expect(matchCount(second.db, 'bravo')).toBe(1)
    second.db.close()
  })

  it('a third boot is still quiet: this does not settle after two', async () => {
    seedExistingInstall()
    for (let i = 0; i < 2; i++) {
      const b = await boot()
      b.db.close()
    }
    const third = await boot()
    expect(third.sql.filter(isVacuum)).toHaveLength(0)
    third.db.close()
  })

  it('after finalize and a reopen, the evidence delete paths still work', async () => {
    // Every one of these queried evidence_fts_map unconditionally. Once the tables are
    // gone they threw "no such table" — breaking delete evidence (inside a BEGIN, so the
    // deletion ROLLBACKs), update evidence content, Rescan, delete case and bundle-import
    // rollback. backfillFtsMaps is worse still: openDb calls it, so a throw there fails
    // startup outright — which means simply reaching the line after openDb below is
    // already part of the assertion.
    const evidenceId = seedExistingInstall()
    const migrating = await boot()
    migrating.db.close()

    const db = openTestDb() // the reopen: openDb -> backfillFtsMaps over a legacy-less DB
    expect(tableNames(db)).not.toContain('evidence_fts_map')

    expect(() => deleteEvidenceIndex(db, evidenceId)).not.toThrow()
    expect(() => deleteEvidenceFtsForCase(db, 1)).not.toThrow()
    expect(() => backfillFtsMaps(db)).not.toThrow()

    // and the delete actually did its job on the surviving generation
    expect(
      (
        db
          .prepare(`SELECT count(*) AS n FROM evidence_index_map WHERE evidence_id = ?`)
          .get(evidenceId) as { n: number }
      ).n
    ).toBe(0)
  })
})

/** Record every `exec` on this handle, still executing it. Return values lie about this
 *  bug — finalize returning false and VACUUM not running are different facts — so the
 *  boot assertions read the SQL that was actually issued. */
function recordExec(db: DatabaseSync): string[] {
  const seen: string[] = []
  const original = db.exec.bind(db)
  db.exec = ((sql: string) => {
    seen.push(sql)
    return original(sql)
  }) as typeof db.exec
  return seen
}

/** `PRAGMA auto_vacuum = INCREMENTAL` must not count as a VACUUM. */
const isVacuum = (sql: string): boolean => /^\s*VACUUM\b/i.test(sql)
const isLegacyDrop = (sql: string): boolean => /^\s*DROP TABLE.*\bevidence_fts(_map)?\b/i.test(sql)

function matchCount(db: DatabaseSync, term: string): number {
  return (
    db.prepare(`SELECT rowid FROM evidence_index WHERE evidence_index MATCH ?`).all(term) as {
      rowid: number
    }[]
  ).length
}
