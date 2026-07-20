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
  driver_cursor TEXT,
  driver_kind TEXT NOT NULL DEFAULT 'claude-agent-sdk',
  -- Which provider INSTANCE (not just driver kind) this chat runs on, and the model chosen
  -- for it. Both nullable: pre-multi-provider rows have neither, and a null model means
  -- "whatever the instance's default is at send time".
  instance_id TEXT,
  model TEXT,
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
  if (!caseCols.some((c) => c.name === 'jira_deselected')) {
    db.exec(`ALTER TABLE cases ADD COLUMN jira_deselected TEXT NOT NULL DEFAULT '[]'`)
  }
  if (!caseCols.some((c) => c.name === 'jira_status')) {
    db.exec(`ALTER TABLE cases ADD COLUMN jira_status TEXT`)
  }
  if (!caseCols.some((c) => c.name === 'jira_priority')) {
    db.exec(`ALTER TABLE cases ADD COLUMN jira_priority TEXT`)
  }
  if (!caseCols.some((c) => c.name === 'jira_comment_count')) {
    db.exec(`ALTER TABLE cases ADD COLUMN jira_comment_count INTEGER`)
  }
  if (!caseCols.some((c) => c.name === 'jira_attachment_ids')) {
    db.exec(`ALTER TABLE cases ADD COLUMN jira_attachment_ids TEXT NOT NULL DEFAULT '[]'`)
  }
  if (!caseCols.some((c) => c.name === 'review_baseline')) {
    db.exec(`ALTER TABLE cases ADD COLUMN review_baseline TEXT`)
  }
  if (!caseCols.some((c) => c.name === 'last_sync_error')) {
    db.exec(`ALTER TABLE cases ADD COLUMN last_sync_error TEXT`)
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
  // Driver-typed resume cursor: rename the Claude-specific sdk_session_id column to
  // driver_cursor and tag every row with the driver that produced it (defaulting existing
  // rows to 'claude-agent-sdk', the only driver that existed before this migration) so a
  // future Copilot driver can never resume a Claude session's cursor and vice versa.
  const cursorCols = db.prepare(`SELECT name FROM pragma_table_info('sessions')`).all() as {
    name: string
  }[]
  const hasSessionCol = (n: string): boolean => cursorCols.some((c) => c.name === n)
  if (hasSessionCol('sdk_session_id') && !hasSessionCol('driver_cursor')) {
    db.exec(`ALTER TABLE sessions RENAME COLUMN sdk_session_id TO driver_cursor`)
  }
  if (!hasSessionCol('driver_kind')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN driver_kind TEXT NOT NULL DEFAULT 'claude-agent-sdk'`)
  }
  // Per-session provider instance + model (multi-provider). Nullable with no default: an
  // existing row predates the concept, and null means "resolve from settings at send time",
  // which is exactly the old behaviour — so no backfill is needed or wanted.
  // NB: `cursorCols` was snapshotted above, so these checks must not depend on columns
  // added earlier in this same block. They don't — both names are new.
  if (!hasSessionCol('instance_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN instance_id TEXT`)
  }
  if (!hasSessionCol('model')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`)
  }
  const turnCols = db.prepare(`PRAGMA table_info(turns)`).all() as { name: string }[]
  if (!turnCols.some((c) => c.name === 'model')) {
    db.exec(`ALTER TABLE turns ADD COLUMN model TEXT`)
  }
  const tcCols = db.prepare(`PRAGMA table_info(tool_calls)`).all() as { name: string }[]
  if (!tcCols.some((c) => c.name === 'detail')) {
    // Usage-stats capture: skill name / memory topic / reference relpath for the calls that
    // have one (see agent/toolDetail.ts); NULL for everything else.
    db.exec(`ALTER TABLE tool_calls ADD COLUMN detail TEXT`)
  }
  return db
}
