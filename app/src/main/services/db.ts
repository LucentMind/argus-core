import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  jira_key TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'upload',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (case_id, rel_path)
);
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  content,
  evidence_id UNINDEXED,
  chunk_index UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  sdk_session_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  turn_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL,
  turn_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL,
  turn_id INTEGER,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  risk TEXT NOT NULL,
  decision TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  session_id INTEGER,
  turn_id INTEGER,
  summary TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'pending',
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  case_id UNINDEXED,
  session_id UNINDEXED,
  turn_id UNINDEXED,
  role UNINDEXED
);
CREATE TABLE IF NOT EXISTS distill_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_slug TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  input_snapshot TEXT NOT NULL,
  raw_output TEXT,
  error TEXT,
  item_count INTEGER,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS case_summaries (
  case_slug TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  symptoms TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  fix TEXT NOT NULL,
  keywords TEXT NOT NULL,
  resolution TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS case_summaries_fts USING fts5(
  signature, symptoms, root_cause, fix, keywords, case_slug UNINDEXED
);
`

export function openDb(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode = WAL;`)
  db.exec(`PRAGMA foreign_keys = ON;`)
  db.exec(SCHEMA)
  const caseCols = db.prepare(`PRAGMA table_info(cases)`).all() as { name: string }[]
  if (!caseCols.some((c) => c.name === 'workspaces')) {
    db.exec(`ALTER TABLE cases ADD COLUMN workspaces TEXT NOT NULL DEFAULT '[]'`)
  }
  if (!caseCols.some((c) => c.name === 'jira_synced_at')) {
    db.exec(`ALTER TABLE cases ADD COLUMN jira_synced_at TEXT`)
  }
  if (!caseCols.some((c) => c.name === 'resolution')) {
    db.exec(`ALTER TABLE cases ADD COLUMN resolution TEXT`)
  }
  // WP-D migration: legacy sessions had UNIQUE(case_id) (one session per case).
  // SQLite can't drop a constraint — rebuild the table once if the unique index exists.
  const sessionIdx = db.prepare(`PRAGMA index_list(sessions)`).all() as {
    origin: string
    unique: number
  }[]
  if (sessionIdx.some((i) => i.unique === 1 && i.origin === 'u')) {
    db.exec(`BEGIN;
      CREATE TABLE sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        sdk_session_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        turn_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions_new (id, case_id, sdk_session_id, turn_count, created_at, updated_at)
        SELECT id, case_id, sdk_session_id, turn_count, created_at, updated_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
    COMMIT;`)
  }
  const sessCols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
  if (!sessCols.some((c) => c.name === 'title')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''`)
  }
  const turnCols = db.prepare(`PRAGMA table_info(turns)`).all() as { name: string }[]
  if (!turnCols.some((c) => c.name === 'model')) {
    db.exec(`ALTER TABLE turns ADD COLUMN model TEXT`)
  }
  return db
}
