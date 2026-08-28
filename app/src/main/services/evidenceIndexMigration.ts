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
 * work, and a crash mid-chunk rolls that chunk back alone (each CHUNK moves in one
 * savepoint — see migrateOneEvidence for why the unit is the chunk, not the row).
 */

/** Mirrors indexer.ts's READ_CHUNK_BYTES: the byte cadence at which the async file indexer
 *  awaits between reads. Kept as a private constant here (rather than importing indexer's)
 *  because this module moves chunks already sitting in the database, not bytes off disk —
 *  the two are conceptually unrelated readers that happen to want the same cadence. */
const YIELD_BYTES = 1024 * 1024

/** How much free space a boot must find before it is worth blocking the app for a full
 *  VACUUM. Ordinary usage (deleting a case, re-indexing a file) frees pages too, and this
 *  function runs a check on every boot once nothing is left to migrate — without a floor,
 *  the very first such delete after an unrelated boot would trigger a multi-minute freeze
 *  for a few reclaimed megabytes. 1 GiB is comfortably above what routine deletes free in
 *  one boot, and comfortably below the tens of gigabytes this migration itself frees. */
export const RECLAIM_THRESHOLD_BYTES = 1024 * 1024 * 1024

interface CountRow {
  n: number
}
interface IdRow {
  evidence_id: number
}
/** One legacy chunk's LOCATOR only. `content` is deliberately not part of this: see
 *  migrateOneEvidence for why the text is fetched a chunk at a time instead. */
interface LegacyChunkLocator {
  fts_rowid: number
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

export interface StopCheck {
  /** Checked between yields — including mid-row, on a huge artifact — so a quit stops
   *  within roughly one YIELD_BYTES cadence rather than waiting for the whole row. */
  shouldStop?: () => boolean
}

/**
 * Move legacy chunks of the lowest remaining evidence id into the contentless index, one
 * chunk at a time, until that row is fully moved or the caller asks to stop. Returns the id
 * worked on, or null when there is nothing left to migrate.
 *
 * ONE SAVEPOINT PER CHUNK, not per row. A whole-row savepoint used to be the unit of
 * atomicity, on the theory that a torn migration would leave half a file's chunks in each
 * generation and make search return that file twice with different line ranges. That
 * theory was wrong: searchEvidence dedups on `evidenceId:startLine`, and a chunk migrated
 * into evidence_index and a chunk still in evidence_fts have DIFFERENT start lines by
 * construction (chunk boundaries never overlap) — so a torn row produces no duplicate, only
 * a row that is correctly split across both generations until the next call finishes it.
 *
 * That correction is what makes chunk-sized savepoints safe, and chunk-sized savepoints are
 * what make this responsive: measured on a real 36.7 GB installation, one whole-row
 * savepoint held a write lock for ~340ms on an average row and up to ~3s on the largest
 * single artifact (199 MB, ~3,945 chunks) — with the main process's event loop, and every
 * other DB write in the app, blocked for the duration. indexer.ts's FtsChunkWriter already
 * solved exactly this for the forward indexer (see its flush()): one savepoint per chunk,
 * opened and closed synchronously, never spanning an await. This mirrors it.
 *
 * The per-chunk savepoint still inserts the evidence_index row AND its evidence_index_map
 * row together (see withFtsSavepoint) — the orphan sweep (deleteOrphanEvidenceIndex) still
 * depends on an index row never existing without its map row pointing at it. It also
 * deletes that chunk's OWN evidence_fts_map row, not the whole evidence id's map rows at
 * the end: with per-chunk atomicity, leaving stale map rows around for chunks already moved
 * would point them at content this function has already deleted from evidence_fts.
 *
 * Returns null, rather than throwing, when the legacy tables are gone entirely — "no
 * legacy tables" and "no rows left in them" mean the same thing to every caller: nothing
 * to migrate. Without this guard, every boot after finalize has run would throw "no such
 * table: evidence_fts_map" from the very first query below.
 */
export async function migrateOneEvidence(
  db: DatabaseSync,
  opts: StopCheck = {}
): Promise<number | null> {
  if (!legacyTablesExist(db)) return null
  const next = db.prepare(`SELECT MIN(evidence_id) AS evidence_id FROM evidence_fts_map`).get() as
    IdRow | undefined
  const evidenceId = next?.evidence_id
  if (evidenceId === null || evidenceId === undefined) return null

  // Locators only — four integers per chunk. Selecting `content` here as well would
  // materialise the entire evidence file in main-process memory in one array: this
  // codebase already ingests 199 MB artifacts, which chunk to ~3,945 rows, and the
  // migration runs on the main process while the app is in use. The text is fetched one
  // chunk at a time below, so peak memory tracks the largest single chunk (400 lines)
  // rather than the largest evidence file.
  const chunks = db
    .prepare(
      `SELECT m.fts_rowid, f.chunk_index, f.start_line, f.end_line
       FROM evidence_fts_map m
       JOIN evidence_fts f ON f.rowid = m.fts_rowid
       WHERE m.evidence_id = ?
       ORDER BY f.chunk_index`
    )
    .all(evidenceId) as unknown as LegacyChunkLocator[]

  const readContent = db.prepare(`SELECT content AS content FROM evidence_fts WHERE rowid = ?`)
  const ins = db.prepare(`INSERT INTO evidence_index (content) VALUES (?)`)
  const insMap = db.prepare(
    `INSERT INTO evidence_index_map (fts_rowid, evidence_id, chunk_index, start_line, end_line)
     VALUES (?, ?, ?, ?, ?)`
  )
  const delFts = db.prepare(`DELETE FROM evidence_fts WHERE rowid = ?`)
  // Keyed on fts_rowid (the map's primary key), not evidence_id: with atomicity moved to
  // the chunk, a partially-migrated row must only lose the map row for the chunk that
  // actually moved, not every chunk still waiting its turn.
  const delMap = db.prepare(`DELETE FROM evidence_fts_map WHERE fts_rowid = ?`)

  let bytesSinceYield = 0
  for (const c of chunks) {
    const content = (readContent.get(c.fts_rowid) as { content: string } | undefined)?.content ?? ''

    // Open and close synchronously, then await OUTSIDE it (see withFtsSavepoint's own
    // warning): spanning an await here would hold a write lock across the yield below and
    // block every other main-process DB write for as long as this row takes.
    withFtsSavepoint(db, () => {
      const rowid = ins.run(content).lastInsertRowid
      insMap.run(rowid, evidenceId, c.chunk_index, c.start_line, c.end_line)
      delFts.run(c.fts_rowid)
      delMap.run(c.fts_rowid)
    })

    bytesSinceYield += Buffer.byteLength(content, 'utf8')
    if (bytesSinceYield >= YIELD_BYTES) {
      await new Promise((resolve) => setImmediate(resolve))
      bytesSinceYield = 0
      // Checked here, not just between rows: a quit during a huge artifact (thousands of
      // chunks) must stop within one yield's worth of work, not wait for the whole row.
      if (opts.shouldStop?.()) break
    }
  }
  return Number(evidenceId)
}

export interface MigrationOptions extends StopCheck {
  onProgress?: (done: number, total: number) => void
  /** Overrides RECLAIM_THRESHOLD_BYTES. Test-only escape hatch — production callers should
   *  leave this unset. */
  reclaimThresholdBytes?: number
}

const PROGRESS_LOG_INTERVAL_MS = 30_000

function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`
}

/** Approximate on-disk size of the main database file, from the pragmas VACUUM itself
 *  reads and shrinks — avoids threading the file path into a module that otherwise only
 *  ever sees the open handle. Excludes the WAL file, so this slightly undercounts. */
function dbSizeBytes(db: DatabaseSync): number {
  const pageCount = Number(
    (db.prepare(`PRAGMA page_count`).get() as { page_count: number }).page_count
  )
  const pageSize = Number((db.prepare(`PRAGMA page_size`).get() as { page_size: number }).page_size)
  return pageCount * pageSize
}

/**
 * Migrate until the legacy table is empty or the caller asks to stop. Yields to the event
 * loop on a byte cadence WITHIN each row (see migrateOneEvidence), not merely between rows:
 * a single evidence row can itself be a 199 MB / ~3,945-chunk artifact, and a tight loop
 * over that many chunks would still block every IPC reply for seconds even if rows
 * alternated with other DB writers perfectly.
 */
export async function runEvidenceIndexMigration(
  db: DatabaseSync,
  opts: MigrationOptions = {}
): Promise<number> {
  const total = legacyIndexRemaining(db)
  if (total > 0) {
    console.log(`[evidence-index] migrating ${total} evidence row(s) into the new index`)
  }
  const start = Date.now()
  const sizeBefore = dbSizeBytes(db)
  let done = 0
  let lastLogged = start
  while (!opts.shouldStop?.()) {
    const moved = await migrateOneEvidence(db, opts)
    if (moved === null) break
    done++
    opts.onProgress?.(done, total)
    const now = Date.now()
    if (now - lastLogged >= PROGRESS_LOG_INTERVAL_MS) {
      console.log(`[evidence-index] migrated ${done}/${total} evidence rows`)
      lastLogged = now
    }
  }
  // Only when the loop drained rather than being stopped: finalize drops tables and may run
  // a VACUUM, neither of which should happen on the way to a quit.
  if (!opts.shouldStop?.() && legacyIndexRemaining(db) === 0) {
    const finalized = finalizeEvidenceIndexMigration(db, opts.reclaimThresholdBytes)
    if (done > 0 || finalized) {
      const sizeAfter = dbSizeBytes(db)
      const elapsedS = (Date.now() - start) / 1000
      console.log(
        `[evidence-index] migration complete: moved ${done} evidence row(s) in ${elapsedS.toFixed(1)}s; ` +
          `database ${fmtBytes(sizeBefore)} -> ${fmtBytes(sizeAfter)}`
      )
    }
  }
  return done
}

/**
 * Drop the legacy contentful pair once every row has moved out of it. Split out of the old
 * combined finalize (see finalizeEvidenceIndexMigration) because dropping is cheap — it
 * commits in milliseconds — while reclaiming the space it frees is not: bundling them meant
 * a force-quit during the slow half looked, on the next boot, like the fast half had never
 * run either.
 *
 * Refuses while any legacy row survives — dropping `evidence_fts` mid-migration would
 * discard content that has no other copy in the database (the file on disk is the only
 * other copy, and re-indexing 26 GB from it is exactly what this migration exists to
 * avoid). Refusing is the caller's job too (see finalizeEvidenceIndexMigration), but this
 * checks again so it is safe to call on its own.
 *
 * The guard is the loose `anyLegacyEvidenceTableExists`, not the strict predicate readers
 * use: the two DROPs below are separate statements, and a crash between them leaves one
 * table behind that only this function will ever clean up.
 */
export function dropLegacyEvidenceTables(db: DatabaseSync): boolean {
  if (legacyIndexRemaining(db) > 0) return false
  if (!anyLegacyEvidenceTableExists(db)) return false
  db.exec(`DROP TABLE IF EXISTS evidence_fts`)
  db.exec(`DROP TABLE IF EXISTS evidence_fts_map`)
  return true
}

/**
 * Return freed pages to the filesystem via VACUUM, but only when there is a meaningful
 * amount to reclaim and only once every legacy row has actually moved.
 *
 * This is the fix for an interrupted VACUUM never being retried. The old combined finalize
 * gated its VACUUM on `anyLegacyEvidenceTableExists`, i.e. "have the DROPs not run yet?".
 * The DROPs commit in milliseconds; the VACUUM that follows runs for minutes with the UI
 * frozen — exactly when an operator force-quits. The DROPs survive that (already
 * committed); the VACUUM rolls back. On the next boot the legacy tables are gone, the old
 * guard read false, and finalize returned immediately — the space was never reclaimed
 * again, silently, forever.
 *
 * The fix is to gate on the space itself instead of on table existence: `freelist_count *
 * page_size` is exactly the bytes VACUUM would return to the filesystem, and it reads that
 * way whether the freed pages came from this boot's DROPs, from an earlier boot's
 * interrupted VACUUM rolling back and leaving them freed-but-unreclaimed, or from ordinary
 * deletes. RECLAIM_THRESHOLD_BYTES (1 GiB) is what keeps the last case from triggering a
 * full VACUUM on routine app usage — see its own comment.
 *
 * Still refuses while any legacy row remains (mirrors dropLegacyEvidenceTables — this can
 * be called independently of it).
 *
 * auto_vacuum=INCREMENTAL is set immediately before VACUUM because it only takes effect
 * across a completed VACUUM (verified empirically: interrupting a VACUUM after setting this
 * pragma and reopening the file reads auto_vacuum back as 0, not 2 — the pragma never
 * commits without a VACUUM actually finishing). Setting it here, every time reclaim
 * actually runs, is what re-arms incremental auto-vacuum after an interrupted attempt left
 * it unset, and is what lets later deletes (case deletion, archiving) return space without
 * another full VACUUM.
 */
export function reclaimEvidenceIndexSpace(
  db: DatabaseSync,
  thresholdBytes: number = RECLAIM_THRESHOLD_BYTES
): boolean {
  if (legacyIndexRemaining(db) > 0) return false
  const freelistCount = Number(
    (db.prepare(`PRAGMA freelist_count`).get() as { freelist_count: number }).freelist_count
  )
  const pageSize = Number((db.prepare(`PRAGMA page_size`).get() as { page_size: number }).page_size)
  const reclaimable = freelistCount * pageSize
  if (reclaimable < thresholdBytes) return false

  // The line that stops someone force-quitting: VACUUM cannot be paused or made async (it
  // is a single blocking SQLite statement, and cannot run inside a transaction), so the
  // only mitigation available is telling the operator what is about to happen and why.
  console.log(
    `[evidence-index] reclaiming ${fmtBytes(reclaimable)} of free space: running VACUUM on a ` +
      `~${fmtBytes(dbSizeBytes(db))} database. This will block the app for a while — do not force-quit.`
  )
  db.exec(`PRAGMA auto_vacuum = INCREMENTAL`)
  db.exec(`VACUUM`)
  return true
}

/**
 * One-shot completion step, run automatically once runEvidenceIndexMigration's loop drains:
 * drop the legacy tables, then reclaim whatever space is worth reclaiming. See
 * dropLegacyEvidenceTables and reclaimEvidenceIndexSpace for why these are two independent
 * functions rather than one — in short, a force-quit during the slow half must not make the
 * fast half's result (or a retry of the slow half) look like it never happened.
 *
 * Refuses while any legacy row survives (checked once, up front, rather than trusting each
 * half to check it — that guard is the one thing both halves must never independently get
 * wrong).
 */
export function finalizeEvidenceIndexMigration(
  db: DatabaseSync,
  reclaimThresholdBytes?: number
): boolean {
  if (legacyIndexRemaining(db) > 0) return false
  const dropped = dropLegacyEvidenceTables(db)
  const reclaimed = reclaimEvidenceIndexSpace(db, reclaimThresholdBytes)
  return dropped || reclaimed
}
