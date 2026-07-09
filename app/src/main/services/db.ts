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
`

export function openDb(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode = WAL;`)
  db.exec(`PRAGMA foreign_keys = ON;`)
  db.exec(SCHEMA)
  return db
}
