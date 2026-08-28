import type { DatabaseSync } from 'node:sqlite'
import {
  anyLegacyEvidenceTableExists,
  legacyEvidenceIndexExists,
  withFtsSavepoint
} from './ftsIndex'

/**
 * Moves evidence chunks from the legacy contentful `evidence_fts` into the contentless
 * `evidence_index`, one evidence row at a time.
 *
 * In-database rather than re-indexing from files, for three reasons. It needs no access
 * to the evidence files, so a case whose files were moved or deleted still migrates. It
 * reproduces chunk boundaries exactly instead of recomputing them, so `start_line` /
 * `end_line` cannot drift. And because each row's old pages are freed as its new rows are
 * written, the database file stays flat instead of peaking at old + new — on the 36.7 GB
 * installation this design targets, re-indexing would have peaked near 47 GB.
 *
 * Progress is the legacy table itself: an evidence id with no rows left in
 * `evidence_fts_map` is migrated. No separate bookkeeping to fall out of step with the
 * work, and a crash mid-row rolls that row back whole (each row moves in one savepoint).
 */

interface CountRow {
  n: number
}
interface IdRow {
  evidence_id: number
}
interface LegacyChunk {
  fts_rowid: number
  content: string
  chunk_index: number
  start_line: number
  end_line: number
}

/**
 * Whether the legacy tables are still around — the single fact every function in this file
 * derives its "already finalized?" answer from, so there is no separate bookkeeping to
 * fall out of step with it.
 *
 * ftsIndex owns the probe (ftsIndex.legacyEvidenceIndexExists); this file, search.ts and
 * ftsIndex's own delete paths all ask the same question, and the version of this bug that
 * shipped was three places forgetting to ask it at all.
 */
const legacyTablesExist = legacyEvidenceIndexExists

/**
 * Distinct evidence ids still holding legacy rows.
 *
 * Treats a missing `evidence_fts_map` (finalize already dropped it) as zero remaining
 * rather than letting the query throw "no such table" — finalize is called automatically
 * once the migration loop drains, and callers (including finalize itself) must be able to
 * ask this again afterwards without special-casing whether that already happened.
 */
export function legacyIndexRemaining(db: DatabaseSync): number {
  if (!legacyTablesExist(db)) return 0
  return Number(
    (
      db
        .prepare(`SELECT COUNT(DISTINCT evidence_id) AS n FROM evidence_fts_map`)
        .get() as unknown as CountRow
    ).n
  )
}

/**
 * Move every legacy chunk of the lowest remaining evidence id into the contentless index.
 * Returns the id moved, or null when nothing is left.
 *
 * One savepoint for the whole evidence row: a torn migration must not leave half a file's
 * chunks in each table, which would make search return the same file twice with different
 * line ranges.
 *
 * Returns null, rather than throwing, when the legacy tables are gone entirely — "no
 * legacy tables" and "no rows left in them" mean the same thing to every caller: nothing
 * to migrate. Without this guard, every boot after finalize has run would throw "no such
 * table: evidence_fts_map" from the very first query below.
 */
export function migrateOneEvidence(db: DatabaseSync): number | null {
  if (!legacyTablesExist(db)) return null
  const next = db.prepare(`SELECT MIN(evidence_id) AS evidence_id FROM evidence_fts_map`).get() as
    IdRow | undefined
  const evidenceId = next?.evidence_id
  if (evidenceId === null || evidenceId === undefined) return null

  const chunks = db
    .prepare(
      `SELECT m.fts_rowid, f.content, f.chunk_index, f.start_line, f.end_line
       FROM evidence_fts_map m
       JOIN evidence_fts f ON f.rowid = m.fts_rowid
       WHERE m.evidence_id = ?
       ORDER BY f.chunk_index`
    )
    .all(evidenceId) as unknown as LegacyChunk[]

  withFtsSavepoint(db, () => {
    const ins = db.prepare(`INSERT INTO evidence_index (content) VALUES (?)`)
    const insMap = db.prepare(
      `INSERT INTO evidence_index_map (fts_rowid, evidence_id, chunk_index, start_line, end_line)
       VALUES (?, ?, ?, ?, ?)`
    )
    const del = db.prepare(`DELETE FROM evidence_fts WHERE rowid = ?`)
    for (const c of chunks) {
      const rowid = ins.run(c.content).lastInsertRowid
      insMap.run(rowid, evidenceId, c.chunk_index, c.start_line, c.end_line)
      del.run(c.fts_rowid)
    }
    db.prepare(`DELETE FROM evidence_fts_map WHERE evidence_id = ?`).run(evidenceId)
  })
  return Number(evidenceId)
}

export interface MigrationOptions {
  onProgress?: (done: number, total: number) => void
  /** Checked before each row. Lets the caller stop at quit without losing finished work. */
  shouldStop?: () => boolean
}

/**
 * Migrate until the legacy table is empty or the caller asks to stop. Yields to the event
 * loop between rows: this runs on the main process during normal use, and a tight loop
 * over tens of thousands of chunks would block every IPC reply for the duration.
 */
export async function runEvidenceIndexMigration(
  db: DatabaseSync,
  opts: MigrationOptions = {}
): Promise<number> {
  const total = legacyIndexRemaining(db)
  let done = 0
  while (!opts.shouldStop?.()) {
    const moved = migrateOneEvidence(db)
    if (moved === null) break
    done++
    opts.onProgress?.(done, total)
    await new Promise((resolve) => setImmediate(resolve))
  }
  // Only when the loop drained rather than being stopped: finalize drops tables and runs a
  // VACUUM, neither of which should happen on the way to a quit.
  if (!opts.shouldStop?.() && legacyIndexRemaining(db) === 0) finalizeEvidenceIndexMigration(db)
  return done
}

/**
 * One-shot completion: drop the legacy tables and return their pages to the filesystem.
 *
 * Refuses while any legacy row survives — dropping `evidence_fts` mid-migration would
 * discard content that has no other copy in the database (the file on disk is the only
 * other copy, and re-indexing 26 GB from it is exactly what this migration exists to
 * avoid).
 *
 * Also refuses once the legacy tables are already gone — i.e. a previous boot already
 * finalized. Without this, `runEvidenceIndexMigration` calling this again on every
 * subsequent boot (its "did the loop drain?" check reads 0 remaining either way) would
 * re-run `VACUUM` on every single startup forever, which on the installation this
 * migration targets is a full pass over a multi-gigabyte database each launch.
 *
 * That guard only holds because db.ts no longer declares the legacy tables. While it did,
 * openDb recreated both of them, empty, on the very next start — the guard passed again,
 * zero rows remained, and the DROP/DROP/VACUUM ran at every launch anyway. The two facts
 * are one mechanism; neither is safe to change alone.
 *
 * The guard is the loose `anyLegacyEvidenceTableExists`, not the strict predicate the
 * readers use: the two DROPs below are separate statements, and a crash between them
 * leaves one table behind that only this function will ever clean up.
 *
 * VACUUM is what actually shrinks the file: the migration frees ~26 GB of pages, but
 * SQLite reuses freed pages rather than truncating, so without this the file stays at its
 * high-water mark forever. It needs free disk roughly equal to the FINAL size (~10 GB),
 * not the current one, and cannot run inside a transaction. auto_vacuum=INCREMENTAL is set
 * first because it only takes effect across a VACUUM, and it is what lets later deletes
 * (case deletion, archiving) return space without another full VACUUM.
 */
export function finalizeEvidenceIndexMigration(db: DatabaseSync): boolean {
  if (!anyLegacyEvidenceTableExists(db)) return false
  if (legacyIndexRemaining(db) > 0) return false
  db.exec(`DROP TABLE IF EXISTS evidence_fts`)
  db.exec(`DROP TABLE IF EXISTS evidence_fts_map`)
  db.exec(`PRAGMA auto_vacuum = INCREMENTAL`)
  db.exec(`VACUUM`)
  return true
}
