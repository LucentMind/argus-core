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

// — evidence_fts —
// (Inserts happen in indexer.ts, which hoists its prepared statements out of the
//  chunk loop for large-file streaming; it writes the evidence_fts_map row inline
//  with the same rowid. Deletes route through the helpers below.)

/** Delete every evidence_fts row for one evidence id (plus its map rows). */
export function deleteEvidenceFtsForEvidence(db: DatabaseSync, evidenceId: number): void {
  const rows = db
    .prepare(`SELECT fts_rowid FROM evidence_fts_map WHERE evidence_id = ?`)
    .all(evidenceId) as unknown as RowidRow[]
  const del = db.prepare(`DELETE FROM evidence_fts WHERE rowid = ?`)
  for (const r of rows) del.run(r.fts_rowid)
  db.prepare(`DELETE FROM evidence_fts_map WHERE evidence_id = ?`).run(evidenceId)
}

/** Delete every evidence_fts row for all evidence of one case (plus map rows). */
export function deleteEvidenceFtsForCase(db: DatabaseSync, caseId: number): void {
  const rows = db
    .prepare(
      `SELECT fts_rowid FROM evidence_fts_map
       WHERE evidence_id IN (SELECT id FROM evidence WHERE case_id = ?)`
    )
    .all(caseId) as unknown as RowidRow[]
  const del = db.prepare(`DELETE FROM evidence_fts WHERE rowid = ?`)
  for (const r of rows) del.run(r.fts_rowid)
  db.prepare(
    `DELETE FROM evidence_fts_map WHERE evidence_id IN (SELECT id FROM evidence WHERE case_id = ?)`
  ).run(caseId)
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
