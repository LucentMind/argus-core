// FTS5 delete-cost fix. evidence_fts / messages_fts are standalone (contentful)
// FTS5 tables whose key columns (evidence_id, case_id, session_id) are UNINDEXED —
// so `DELETE FROM ..._fts WHERE evidence_id = ?` scans the ENTIRE index, and that
// scan grows with the whole database, not with the rows being deleted. FTS5 only
// addresses a row cheaply by its integer rowid (docid); it does NOT optimise
// `rowid IN (subquery)` either (verified: still a full SCAN) — only `rowid = ?`.
//
// So each FTS table gets a plain B-tree side table mapping key -> fts rowid. To
// delete, we look the rowids up through the (indexed) map and delete each by
// `rowid = ?`. Cost then scales with the rows removed, independent of total DB
// size. Search queries are untouched — the FTS tables still hold the content.
import type { DatabaseSync } from 'node:sqlite'

interface RowidRow {
  fts_rowid: number
}

/**
 * Run `fn` as one atomic unit, whether or not a transaction is already open.
 *
 * An FTS row and its map row must be written together or not at all: a crash (or a
 * throw) between the two statements leaves an FTS row no map row points at, which
 * `deleteEvidenceFtsForEvidence` — which resolves rowids THROUGH the map — can never
 * see. That residue survives crash-recovery's delete, duplicates the chunk on the
 * re-index, and can never be reclaimed, not even when the evidence itself is deleted.
 *
 * SAVEPOINT, not BEGIN. Some callers already sit inside an explicit BEGIN (see
 * ingest.ts deleteEvidence), and node:sqlite rejects a nested BEGIN outright
 * ("cannot start a transaction within a transaction" — verified against the bundled
 * node:sqlite, not assumed). SAVEPOINT nests, and when no outer transaction is
 * active it opens one itself, so the outermost RELEASE commits. One name is reused
 * because each savepoint is released before the next is opened.
 *
 * Keep the callable short and SYNCHRONOUS. Spanning an `await` would hold a write
 * lock open across the async indexer's read loop and block every other main-process
 * DB write for the length of a multi-hundred-megabyte file.
 */
export function withFtsSavepoint<T>(db: DatabaseSync, fn: () => T): T {
  db.exec(`SAVEPOINT argus_fts`)
  try {
    const out = fn()
    db.exec(`RELEASE argus_fts`)
    return out
  } catch (err) {
    // ROLLBACK TO only rewinds the savepoint; the savepoint itself stays on the
    // stack until it is released, so both statements are required.
    db.exec(`ROLLBACK TO argus_fts`)
    db.exec(`RELEASE argus_fts`)
    throw err
  }
}

// — evidence_fts —
// (Inserts happen in indexer.ts, which hoists its prepared statements out of the
//  chunk loop for large-file streaming; it writes the evidence_fts_map row inline
//  with the same rowid. Deletes route through the helpers below.)

/** Delete every indexed chunk for one evidence id, from both index generations.
 *
 *  Both, deliberately: until the migration in evidenceIndexMigration.ts finishes, one
 *  evidence row's chunks can sit in the legacy contentful table, in the contentless one,
 *  or briefly in both. Clearing only one leaves searchable rows behind for evidence that
 *  no longer exists. */
export function deleteEvidenceFtsForEvidence(db: DatabaseSync, evidenceId: number): void {
  const legacy = db
    .prepare(`SELECT fts_rowid FROM evidence_fts_map WHERE evidence_id = ?`)
    .all(evidenceId) as unknown as RowidRow[]
  const delLegacy = db.prepare(`DELETE FROM evidence_fts WHERE rowid = ?`)
  for (const r of legacy) delLegacy.run(r.fts_rowid)
  db.prepare(`DELETE FROM evidence_fts_map WHERE evidence_id = ?`).run(evidenceId)

  const current = db
    .prepare(`SELECT fts_rowid FROM evidence_index_map WHERE evidence_id = ?`)
    .all(evidenceId) as unknown as RowidRow[]
  const delCurrent = db.prepare(`DELETE FROM evidence_index WHERE rowid = ?`)
  for (const r of current) delCurrent.run(r.fts_rowid)
  db.prepare(`DELETE FROM evidence_index_map WHERE evidence_id = ?`).run(evidenceId)
}

/**
 * Remove every contentless index row that no map row points at, and report how many.
 *
 * Replaces the old map-independent `deleteEvidenceFtsThorough`, which filtered on
 * `evidence_id` — a column a contentless table does not have. This is the better
 * definition anyway: an orphan is a row with no locator, whichever evidence it came
 * from, so one global sweep at boot replaces a per-row full-index scan.
 *
 * Contentless FTS5 tables support rowid scans and rowid deletes (verified on SQLite
 * 3.50.4); only column reads and snippet() are unavailable.
 */
export function deleteOrphanEvidenceIndex(db: DatabaseSync): number {
  const res = db
    .prepare(
      `DELETE FROM evidence_index
       WHERE rowid NOT IN (SELECT fts_rowid FROM evidence_index_map)`
    )
    .run()
  return Number(res.changes)
}

/** Delete every indexed chunk for all evidence of one case, from both generations. */
export function deleteEvidenceFtsForCase(db: DatabaseSync, caseId: number): void {
  const inCase = `SELECT id FROM evidence WHERE case_id = ?`
  const legacy = db
    .prepare(`SELECT fts_rowid FROM evidence_fts_map WHERE evidence_id IN (${inCase})`)
    .all(caseId) as unknown as RowidRow[]
  const delLegacy = db.prepare(`DELETE FROM evidence_fts WHERE rowid = ?`)
  for (const r of legacy) delLegacy.run(r.fts_rowid)
  db.prepare(`DELETE FROM evidence_fts_map WHERE evidence_id IN (${inCase})`).run(caseId)

  const current = db
    .prepare(`SELECT fts_rowid FROM evidence_index_map WHERE evidence_id IN (${inCase})`)
    .all(caseId) as unknown as RowidRow[]
  const delCurrent = db.prepare(`DELETE FROM evidence_index WHERE rowid = ?`)
  for (const r of current) delCurrent.run(r.fts_rowid)
  db.prepare(`DELETE FROM evidence_index_map WHERE evidence_id IN (${inCase})`).run(caseId)
}

// — messages_fts —

/** Insert one messages_fts row and its map entry. */
export function insertMessageFts(
  db: DatabaseSync,
  content: string,
  caseId: number,
  sessionId: number,
  turnId: number | null,
  role: string
): void {
  const rowid = Number(
    db
      .prepare(
        `INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES (?, ?, ?, ?, ?)`
      )
      .run(content, caseId, sessionId, turnId, role).lastInsertRowid
  )
  db.prepare(`INSERT INTO messages_fts_map (fts_rowid, case_id, session_id) VALUES (?, ?, ?)`).run(
    rowid,
    caseId,
    sessionId
  )
}

/** Delete every messages_fts row for one session (plus map rows). */
export function deleteMessagesFtsForSession(db: DatabaseSync, sessionId: number): void {
  const rows = db
    .prepare(`SELECT fts_rowid FROM messages_fts_map WHERE session_id = ?`)
    .all(sessionId) as unknown as RowidRow[]
  const del = db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`)
  for (const r of rows) del.run(r.fts_rowid)
  db.prepare(`DELETE FROM messages_fts_map WHERE session_id = ?`).run(sessionId)
}

/** Delete every messages_fts row for one case (plus map rows). */
export function deleteMessagesFtsForCase(db: DatabaseSync, caseId: number): void {
  const rows = db
    .prepare(`SELECT fts_rowid FROM messages_fts_map WHERE case_id = ?`)
    .all(caseId) as unknown as RowidRow[]
  const del = db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`)
  for (const r of rows) del.run(r.fts_rowid)
  db.prepare(`DELETE FROM messages_fts_map WHERE case_id = ?`).run(caseId)
}

// — migration —

/**
 * One-time backfill of the FTS map tables for a DB that already holds FTS rows
 * from before this fix. Runs on openDb after the schema is ensured. Gated on the
 * map being empty (post-migration the maps stay in sync via the helpers above),
 * so it scans each FTS table at most once, ever.
 */
export function backfillFtsMaps(db: DatabaseSync): void {
  const evMapEmpty =
    (db.prepare(`SELECT COUNT(*) AS n FROM evidence_fts_map`).get() as { n: number }).n === 0
  if (evMapEmpty && db.prepare(`SELECT rowid FROM evidence_fts LIMIT 1`).get()) {
    db.exec(
      `INSERT INTO evidence_fts_map (fts_rowid, evidence_id)
       SELECT rowid, evidence_id FROM evidence_fts`
    )
  }
  const msgMapEmpty =
    (db.prepare(`SELECT COUNT(*) AS n FROM messages_fts_map`).get() as { n: number }).n === 0
  if (msgMapEmpty && db.prepare(`SELECT rowid FROM messages_fts LIMIT 1`).get()) {
    db.exec(
      `INSERT INTO messages_fts_map (fts_rowid, case_id, session_id)
       SELECT rowid, case_id, session_id FROM messages_fts`
    )
  }
}
