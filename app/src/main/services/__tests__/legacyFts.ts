import type { DatabaseSync } from 'node:sqlite'

/**
 * Test-only: recreate the pre-migration contentful evidence index, exactly as a release
 * before the contentless one left it in a user's database.
 *
 * db.ts deliberately no longer declares these two tables (see the comment beside
 * evidence_index there): openDb execs its schema on every start, so while the CREATEs
 * lived there the boot after finalizeEvidenceIndexMigration dropped them recreated both,
 * empty, and finalize re-ran DROP/DROP/VACUUM at every launch forever.
 *
 * That leaves this the only surviving copy of their column list, which is fine and is the
 * point: it is frozen history — an older release's schema, which cannot change — rather
 * than a second live declaration that could drift from a first. A test that wants an
 * "existing install" calls this after openDb; a test that wants a "fresh install" simply
 * does not.
 *
 * Not a `.test.ts` file, so vitest's include glob (`**\/__tests__\/**\/*.test.ts`) does not
 * try to run it as a suite.
 */
export function createLegacyEvidenceFts(db: DatabaseSync): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
      content,
      evidence_id UNINDEXED,
      chunk_index UNINDEXED,
      start_line UNINDEXED,
      end_line UNINDEXED
    );
    CREATE TABLE IF NOT EXISTS evidence_fts_map (
      fts_rowid INTEGER PRIMARY KEY,
      evidence_id INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_fts_map_evidence_id ON evidence_fts_map(evidence_id);
  `)
}
