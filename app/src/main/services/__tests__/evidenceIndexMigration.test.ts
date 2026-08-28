import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import {
  dropLegacyEvidenceTables,
  finalizeEvidenceIndexMigration,
  legacyIndexRemaining,
  migrateOneEvidence,
  reclaimEvidenceIndexSpace,
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

/** Drain migrateOneEvidence directly (not runEvidenceIndexMigration, which auto-finalizes
 *  once it drains) so a test can exercise finalize/drop/reclaim in isolation afterwards. */
async function drain(db: DatabaseSync): Promise<void> {
  while ((await migrateOneEvidence(db)) !== null) {
    /* drain */
  }
}

describe('evidence index migration', () => {
  it('moves one evidence row, preserving chunk boundaries exactly', async () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [
      { text: 'first chunk text', from: 1, to: 400 },
      { text: 'second chunk text', from: 401, to: 640 }
    ])

    expect(await migrateOneEvidence(db)).toBe(id)

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

  it('carries each chunk’s text across, not just its locator', async () => {
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

    await migrateOneEvidence(db)

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

  it('leaves the legacy table empty for the migrated row', async () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [{ text: 'only chunk', from: 1, to: 10 }])
    await migrateOneEvidence(db)
    expect(
      (
        db.prepare(`SELECT count(*) AS n FROM evidence_fts_map WHERE evidence_id = ?`).get(id) as {
          n: number
        }
      ).n
    ).toBe(0)
    expect((db.prepare(`SELECT count(*) AS n FROM evidence_fts`).get() as { n: number }).n).toBe(0)
  })

  it('keeps the migrated text searchable', async () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [{ text: 'connection refused by peer', from: 1, to: 1 }])
    await migrateOneEvidence(db)
    const hit = db
      .prepare(`SELECT rowid FROM evidence_index WHERE evidence_index MATCH ?`)
      .all('"connection refused"') as unknown as { rowid: number }[]
    expect(hit).toHaveLength(1)
  })

  it('returns null and moves nothing when the legacy table is empty', async () => {
    const db = openTestDb()
    expect(await migrateOneEvidence(db)).toBeNull()
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

  // Load-bearing: each CHUNK moves inside ONE withFtsSavepoint, and that savepoint writes
  // the evidence_index row and its evidence_index_map row together. The orphan sweep
  // (deleteOrphanEvidenceIndex) still depends on an index row never being written without
  // its map row in the same savepoint -- this is the chunk-granularity version of the guard
  // the old row-granularity test covered.
  it('rolls back only the failed chunk, leaving earlier chunks migrated and the rest still legacy', async () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [
      { text: 'chunk zero', from: 1, to: 10 },
      { text: 'chunk one', from: 11, to: 20 },
      { text: 'chunk two', from: 21, to: 30 }
    ])
    // Fail the third chunk's map insert, standing in for a crash mid-chunk.
    db.exec(
      `CREATE TRIGGER argus_test_block_third_map BEFORE INSERT ON evidence_index_map
       WHEN (SELECT COUNT(*) FROM evidence_index_map) = 2
       BEGIN SELECT RAISE(ABORT, 'interrupted mid-row'); END`
    )

    await expect(migrateOneEvidence(db)).rejects.toThrow(/interrupted/)

    // Chunks zero and one: already committed via their OWN savepoints before chunk two's
    // savepoint ever opened -- a per-chunk atomicity unit means their success does not
    // depend on chunk two's outcome.
    expect(
      (
        db
          .prepare(`SELECT count(*) AS n FROM evidence_index_map WHERE evidence_id = ?`)
          .get(id) as { n: number }
      ).n
    ).toBe(2)
    // Chunk two: its own savepoint rolled back, so it is untouched in the legacy tables.
    expect(
      (
        db.prepare(`SELECT count(*) AS n FROM evidence_fts WHERE evidence_id = ?`).get(id) as {
          n: number
        }
      ).n
    ).toBe(1)
    expect(
      (
        db.prepare(`SELECT count(*) AS n FROM evidence_fts_map WHERE evidence_id = ?`).get(id) as {
          n: number
        }
      ).n
    ).toBe(1)
  })

  it('is resumable mid-row: a quit between yields leaves only the unmigrated chunks behind', async () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    // ~600KB per chunk: chunk 0 alone stays under the 1MB yield cadence, but chunk 0 + 1
    // crosses it, so the FIRST yield -- and the first shouldStop check -- lands right after
    // chunk 1, with chunk 2 not yet touched.
    const big = 'z'.repeat(600_000)
    seedLegacy(db, id, [
      { text: big, from: 1, to: 10 },
      { text: big, from: 11, to: 20 },
      { text: 'small tail', from: 21, to: 22 }
    ])

    expect(await migrateOneEvidence(db, { shouldStop: () => true })).toBe(id)

    expect(
      (
        db
          .prepare(`SELECT count(*) AS n FROM evidence_index_map WHERE evidence_id = ?`)
          .get(id) as { n: number }
      ).n
    ).toBe(2)
    expect(
      (
        db.prepare(`SELECT count(*) AS n FROM evidence_fts_map WHERE evidence_id = ?`).get(id) as {
          n: number
        }
      ).n
    ).toBe(1)

    // Resuming without shouldStop finishes the row from exactly where it left off.
    expect(await migrateOneEvidence(db)).toBe(id)
    expect(
      (
        db.prepare(`SELECT count(*) AS n FROM evidence_fts_map WHERE evidence_id = ?`).get(id) as {
          n: number
        }
      ).n
    ).toBe(0)
    expect(
      (
        db
          .prepare(`SELECT count(*) AS n FROM evidence_index_map WHERE evidence_id = ?`)
          .get(id) as { n: number }
      ).n
    ).toBe(3)
  })

  // Verifies the responsiveness claim empirically rather than asserting it: a chunk-heavy
  // row must yield the event loop repeatedly WHILE it migrates, not once at the very end.
  // Against the old per-row-savepoint code (no await anywhere inside the row), a background
  // setImmediate probe would fire at most once before migrateOneEvidence's synchronous body
  // had already run to completion -- see the mutation note below for the actual number this
  // produced when checked against that code.
  it('yields to the event loop repeatedly while migrating a chunk-heavy row', async () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    const chunkText = 'y'.repeat(250_000) // ~250KB/chunk
    const chunks = Array.from({ length: 20 }, (_, i) => ({
      text: chunkText,
      from: i * 10 + 1,
      to: i * 10 + 10
    })) // 20 * 250KB = ~5MB legacy content -> ~5 crossings of the 1MB yield cadence
    seedLegacy(db, id, chunks)

    const probeTimes: number[] = [performance.now()]
    let probing = true
    const probe = (): void => {
      probeTimes.push(performance.now())
      if (probing) setImmediate(probe)
    }
    setImmediate(probe)

    await migrateOneEvidence(db)
    probing = false
    probeTimes.push(performance.now())

    const gaps = probeTimes.slice(1).map((t, i) => t - probeTimes[i])
    const maxGap = Math.max(...gaps)
    // Generous bound for a loaded CI box: a single unbroken synchronous block moving ~5MB
    // of legacy content through SQLite comfortably exceeds this on the hardware the 340ms/
    // row and 3s/artifact numbers in the file header comment were measured on.
    expect(maxGap).toBeLessThan(1000)
    // Robustness net against wall-clock flakiness: the probe must have actually fired
    // several times DURING the migration (not just once before and once after), proving
    // multiple real yields happened, independent of how long each gap measured.
    expect(probeTimes.length).toBeGreaterThanOrEqual(5)
  })
})

describe('drop + reclaim (finalize split into its two halves)', () => {
  it('refuses to drop or reclaim anything while legacy rows remain', () => {
    const db = openTestDb()
    seedLegacy(db, seedEvidence(db), [{ text: 'still here', from: 1, to: 1 }])
    expect(dropLegacyEvidenceTables(db)).toBe(false)
    expect(reclaimEvidenceIndexSpace(db, 0)).toBe(false)
    expect(finalizeEvidenceIndexMigration(db)).toBe(false)
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts'`).get()
    ).toBeTruthy()
  })

  it('drops both legacy tables once nothing is left', async () => {
    const db = openTestDb()
    seedLegacy(db, seedEvidence(db), [{ text: 'move me', from: 1, to: 1 }])
    await drain(db)
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

  it('still cleans up when a crash left only one of the two legacy tables', async () => {
    // The two DROPs are separate statements; a crash between them leaves evidence_fts_map
    // behind with no content table to join. Readers treat that as "legacy gone" (they
    // would throw on the missing half); finalize is the one caller that must still fire,
    // or the residue is never reclaimed.
    const db = openTestDb()
    seedLegacy(db, seedEvidence(db), [{ text: 'half dropped', from: 1, to: 1 }])
    await drain(db)
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

  // — the threshold gate —
  //
  // reclaimEvidenceIndexSpace must not fire a multi-minute VACUUM merely because a boot
  // finds a little garbage (ordinary usage -- deleting a case, re-indexing a file -- frees
  // pages too). It must fire once the freed space is meaningful. reclaimThresholdBytes lets
  // these tests pick either side of that line deterministically without writing gigabytes
  // of throwaway data.
  describe('the reclaim threshold', () => {
    it('does not VACUUM when reclaimable space is below the threshold', async () => {
      const db = openTestDb()
      seedLegacy(db, seedEvidence(db), [{ text: 'move me', from: 1, to: 1 }])
      const sql = recordExec(db)
      await runEvidenceIndexMigration(db, { reclaimThresholdBytes: Number.MAX_SAFE_INTEGER })
      expect(sql.filter(isVacuum)).toHaveLength(0)
      expect((db.prepare(`PRAGMA auto_vacuum`).get() as { auto_vacuum: number }).auto_vacuum).toBe(
        0
      )
    })

    it('VACUUMs, and enables incremental auto_vacuum, once reclaimable space crosses the threshold', async () => {
      const db = openTestDb()
      seedLegacy(db, seedEvidence(db), [{ text: 'move me', from: 1, to: 1 }])
      const sql = recordExec(db)
      // 1 byte: this fixture's DROP alone frees several KB of freelist, comfortably above.
      await runEvidenceIndexMigration(db, { reclaimThresholdBytes: 1 })
      expect(sql.filter(isVacuum)).toHaveLength(1)
      expect((db.prepare(`PRAGMA auto_vacuum`).get() as { auto_vacuum: number }).auto_vacuum).toBe(
        2
      )
    })

    it('refuses to reclaim while any legacy row remains, however low the threshold', () => {
      const db = openTestDb()
      seedLegacy(db, seedEvidence(db), [{ text: 'still here', from: 1, to: 1 }])
      // threshold 0: if the "rows remain" guard were missing, reclaimable (>= 0) would
      // never be < 0, and this would VACUUM straight through content that has no other
      // copy in the database.
      expect(reclaimEvidenceIndexSpace(db, 0)).toBe(false)
    })
  })

  // — the interrupted-VACUUM retry —
  //
  // This is the defect itself: the old finalize gated its VACUUM on "do the legacy tables
  // still exist?". The DROPs that remove them commit in milliseconds; the VACUUM that
  // follows can run for minutes. A force-quit during the VACUUM rolls the VACUUM back but
  // leaves the (already-committed) DROPs in place -- so the old guard read "already done"
  // forever after, and the space was never reclaimed. See the migration-responsiveness
  // report for the empirical process-kill proof that PRAGMA auto_vacuum reads back 0 (not
  // 2) after exactly this interruption, which is why reclaim gates on freelist bytes
  // instead of on that pragma.
  it('retries reclaiming space on a later boot when the legacy tables are already gone but the space was never reclaimed', async () => {
    const db1 = openTestDb()
    seedLegacy(db1, seedEvidence(db1), [{ text: 'move me', from: 1, to: 1 }])
    await drain(db1)
    // Drop, but do NOT reclaim -- stands in for the DROPs committing while the VACUUM that
    // should have followed them was interrupted and rolled back.
    expect(dropLegacyEvidenceTables(db1)).toBe(true)
    db1.close()

    const db2 = openTestDb()
    expect(
      db2.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts'`).get()
    ).toBeUndefined()
    // The old bug: anyLegacyEvidenceTableExists is false here, so the old combined finalize
    // returned immediately and this VACUUM never ran, ever again.
    expect(reclaimEvidenceIndexSpace(db2, 1)).toBe(true)
    expect((db2.prepare(`PRAGMA auto_vacuum`).get() as { auto_vacuum: number }).auto_vacuum).toBe(2)
  })
})

// — what actually happens at startup —
//
// Nothing above this point describes a boot: they all hold ONE handle open for the whole
// test. The defect this block exists to catch lived precisely in the gap between those two
// things. finalize's "have I already run?" question used to be "do the legacy tables
// exist?", and db.ts's schema -- which openDb execs on EVERY open -- used to declare both of
// them. So the next time the process opened the file, the tables finalize had just dropped
// came back, empty; the guard passed again; zero rows remained; and DROP/DROP/PRAGMA/VACUUM
// ran again. On the multi-gigabyte installation this migration targets that is a full
// rewrite of the database at every single launch, forever. A single-handle test cannot see
// it, because openDb never runs a second time.
//
// So each "boot" here closes the handle and reopens the same path through the real openDb,
// then makes the call main/index.ts makes. And the assertions are on the SQL actually
// issued, not on return values: finalize returning false is not the same fact as VACUUM not
// running.
describe('boots: the same database file, closed and reopened through openDb', () => {
  interface Boot {
    db: DatabaseSync
    sql: string[]
  }

  /** One application start: open the file, then run the migration exactly as
   *  main/index.ts does. `reclaimThresholdBytes` mirrors main/index.ts leaving it at the
   *  production default UNLESS a test overrides it -- most of these boots only seed a
   *  handful of bytes of legacy content, nowhere near the real 1 GiB floor, so tests that
   *  need to *see* a VACUUM fire pass a tiny override; tests proving VACUUM must NOT fire
   *  (the fresh-install boots) use the real default. The caller closes `db` to end the
   *  boot. */
  async function boot(reclaimThresholdBytes?: number): Promise<Boot> {
    const db = openDb(dbFile())
    opened.push(db)
    const sql = recordExec(db)
    await runEvidenceIndexMigration(db, { reclaimThresholdBytes })
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

  it('existing install: boot 1 migrates, drops and reclaims once, boot 2 does neither', async () => {
    seedExistingInstall()

    const first = await boot(1) // tiny threshold: this fixture is far below the real 1 GiB floor
    expect(first.sql.filter(isVacuum)).toHaveLength(1)
    expect(first.sql.filter(isLegacyDrop)).toHaveLength(2)
    expect(tableNames(first.db)).not.toContain('evidence_fts')
    // the content moved rather than being discarded
    expect(matchCount(first.db, 'bravo')).toBe(1)
    first.db.close()

    const second = await boot(1)
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
      const b = await boot(1)
      b.db.close()
    }
    const third = await boot(1)
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
    const migrating = await boot(1)
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

  it('an interrupted VACUUM (tables dropped, space unreclaimed) is retried on the next boot', async () => {
    // Simulates a force-quit during the VACUUM: the DROPs from boot 1 committed, but the
    // reclaim step itself did not run this boot (reclaimThresholdBytes left at the
    // production default, which this tiny fixture never crosses) -- exactly the state a
    // real interrupted VACUUM leaves behind (see the empirical PRAGMA investigation in the
    // migration-responsiveness report).
    seedExistingInstall()
    const first = await boot() // production default threshold: drops, does NOT reclaim
    expect(first.sql.filter(isLegacyDrop)).toHaveLength(2)
    expect(first.sql.filter(isVacuum)).toHaveLength(0)
    first.db.close()

    const second = await boot(1) // later boot, tiny threshold: must retry the reclaim
    expect(second.sql.filter(isVacuum)).toHaveLength(1)
    expect(
      (second.db.prepare(`PRAGMA auto_vacuum`).get() as { auto_vacuum: number }).auto_vacuum
    ).toBe(2)
    second.db.close()
  })
})

describe('logging (problem 3: the migration is otherwise invisible)', () => {
  it('logs how many rows remain at the start, and a completion summary at the end', async () => {
    const db = openTestDb()
    for (const id of [seedEvidence(db), seedEvidence(db)])
      seedLegacy(db, id, [{ text: 'x', from: 1, to: 1 }])
    const lines = await captureConsoleLog(() =>
      runEvidenceIndexMigration(db, { reclaimThresholdBytes: 1 })
    )
    expect(lines.some((l) => /\[evidence-index\].*migrating 2 evidence row/.test(l))).toBe(true)
    expect(lines.some((l) => /\[evidence-index\].*migration complete.*moved 2/.test(l))).toBe(true)
  })

  it('warns immediately before the blocking VACUUM', async () => {
    const db = openTestDb()
    seedLegacy(db, seedEvidence(db), [{ text: 'move me', from: 1, to: 1 }])
    await drain(db)
    dropLegacyEvidenceTables(db)
    const lines = await captureConsoleLog(() => reclaimEvidenceIndexSpace(db, 1))
    expect(lines.some((l) => /\[evidence-index\].*VACUUM/.test(l) && /force-quit/.test(l))).toBe(
      true
    )
  })

  it('logs nothing when there is no work and nothing to reclaim', async () => {
    const db = openTestDb()
    const lines = await captureConsoleLog(() => finalizeEvidenceIndexMigration(db))
    expect(lines).toHaveLength(0)
  })
})

/**
 * Capture every `console.log` call made while `fn` runs, as stringified first arguments.
 *
 * NOT `vi.spyOn(console, 'log')` — verified empirically that it silently captures zero
 * calls in this project's vitest setup (v4, with per-test console-output interception),
 * even though `console.log`'s own property descriptor is a perfectly ordinary writable,
 * configurable data property. Plain reassignment, restored in a `finally`, does capture
 * every call reliably.
 */
async function captureConsoleLog(fn: () => unknown): Promise<string[]> {
  const original = console.log
  const lines: string[] = []
  console.log = ((...args: unknown[]) => {
    lines.push(String(args[0]))
  }) as typeof console.log
  try {
    await fn()
  } finally {
    console.log = original
  }
  return lines
}

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
