import type { DatabaseSync } from 'node:sqlite'
import { withFtsSavepoint } from './ftsIndex'

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

/** Distinct evidence ids still holding legacy rows. */
export function legacyIndexRemaining(db: DatabaseSync): number {
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
 */
export function migrateOneEvidence(db: DatabaseSync): number | null {
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
  return done
}
