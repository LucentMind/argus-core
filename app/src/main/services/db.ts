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
  case_id INTEGER NOT NULL UNIQUE REFERENCES cases(id) ON DELETE CASCADE,
  sdk_session_id TEXT,
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
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  case_id UNINDEXED,
  session_id UNINDEXED,
  turn_id UNINDEXED,
  role UNINDEXED
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
  return db
}
