import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backfillFtsMaps } from './ftsIndex'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  jira_key TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL DEFAULT 'user',
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
  prompt_hash TEXT,
  raw_output TEXT,
  error TEXT,
  item_count INTEGER,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS rca_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_slug TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  input_snapshot TEXT NOT NULL,
  prompt_hash TEXT,
  raw_output TEXT,
  error TEXT,
  confirmed_at TEXT,
  post_results TEXT,
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
CREATE TABLE IF NOT EXISTS pr_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  repo_path TEXT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  UNIQUE(case_id, owner, repo, number)
);
-- Last fetched PR + CI state, one row per case (a case binds at most one PR, so case_id is the
-- key and its own FK index). Stored as a JSON projection of a remote API rather than columns:
-- nothing queries it by field — every consumer reads the whole status for one or more cases and
-- renders it — so columns would be schema churn with no query to serve.
CREATE TABLE IF NOT EXISTS pr_status_cache (
  case_id INTEGER PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  fetched_at TEXT NOT NULL,
  status_json TEXT NOT NULL
);
-- Foreign-key indexes. With PRAGMA foreign_keys=ON, an ON DELETE CASCADE on the
-- parent (cases) forces SQLite to find matching child rows; without an index on
-- the child's FK column that is a FULL TABLE SCAN per cascade, so deleting one
-- case scanned all of tool_calls/turns/sessions/findings. evidence(case_id) is
-- already covered by its UNIQUE(case_id, rel_path). session_id indexes serve the
-- per-session deletes/lookups (deleteSession, chat search).
CREATE INDEX IF NOT EXISTS idx_sessions_case_id      ON sessions(case_id);
CREATE INDEX IF NOT EXISTS idx_turns_case_id         ON turns(case_id);
CREATE INDEX IF NOT EXISTS idx_turns_session_id      ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_case_id    ON tool_calls(case_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_findings_case_id      ON findings(case_id);
-- pr_bindings(case_id) has no separate FK index: the UNIQUE index created below
-- (pr_bindings_one_per_case) already covers case_id as its leading column, so a
-- second non-unique index on the same column would be pure redundancy.
-- key -> fts rowid side tables (see ftsIndex.ts): the FTS key columns are
-- UNINDEXED, so deleting by them scanned the whole index. These let deletes
-- resolve rowids by index and delete each by rowid.
CREATE TABLE IF NOT EXISTS evidence_fts_map (
  fts_rowid INTEGER PRIMARY KEY,
  evidence_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_fts_map_evidence_id ON evidence_fts_map(evidence_id);
CREATE TABLE IF NOT EXISTS messages_fts_map (
  fts_rowid INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL,
  session_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_fts_map_case_id    ON messages_fts_map(case_id);
CREATE INDEX IF NOT EXISTS idx_messages_fts_map_session_id ON messages_fts_map(session_id);
-- Manual repo-link usage record (recent-repos feature). No FK to cases on purpose: these
-- rows are a usage record, not a live relationship. A cascade on case delete would walk the
-- count backwards and revoke a promote prompt the user had already earned. Nothing ever
-- joins these tables against cases, so the missing FK costs nothing -- and it keeps them off
-- the FK-index/delete-performance path the evidence tables needed.
CREATE TABLE IF NOT EXISTS repo_usage (
  path      TEXT NOT NULL,
  case_slug TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (path, case_slug)
);
CREATE TABLE IF NOT EXISTS repo_prefs (
  path              TEXT PRIMARY KEY,
  promote_dismissed INTEGER NOT NULL DEFAULT 0
);
-- One row per routine invocation (spec 2026-08-03-routines §2). routine_id references a
-- definition in config/routines.json, not a table row — no FK. case_slug is denormalized so
-- the run list renders without a join even if the case is later deleted. summary holds the
-- final assistant text; per-item outcomes arrive with the pre-triage template increment.
CREATE TABLE IF NOT EXISTS routine_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id TEXT NOT NULL,
  case_slug TEXT NOT NULL,
  session_id INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT,
  error TEXT,
  trigger_kind TEXT NOT NULL DEFAULT 'manual',
  -- Increment 3: when a human cleared this run from the Home inbox. NULL = unreviewed.
  -- Nullable rather than a boolean + timestamp pair: one column answers both "is it in the
  -- inbox" and "when was it cleared".
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id);
-- When a routine was first seen with a schedule — the origin its first fire is measured from,
-- for a routine that has no rows in routine_runs yet. Persisted rather than derived from process
-- start: an in-memory anchor moves on every launch, which makes a freshly saved routine already
-- overdue once uptime exceeds its period, and makes a routine whose period exceeds typical uptime
-- unable to ever fire at all. Written by ensureRoutineAnchor, dropped by forgetRoutineAnchor when
-- the definition is deleted (services/routines/anchors.ts).
CREATE TABLE IF NOT EXISTS routine_anchors (
  routine_id TEXT PRIMARY KEY,
  anchored_at TEXT NOT NULL
);
`

export function openDb(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode = WAL;`)
  db.exec(`PRAGMA foreign_keys = ON;`)
  db.exec(SCHEMA)
  // One pull request per case (plan 2026-07-27-one-pr-per-case). The citation grammar findings
  // use — [<repo-name>/<path>:<line>] — cannot name a PR number, so two PRs bound in one repo
  // are indistinguishable to every consumer downstream. Enforced here rather than by convention
  // because three separate review rounds found the same wrong-PR bug when it was convention.
  //
  // A case with MORE THAN ONE binding has every binding deleted, not just trimmed down to one:
  // there is no principled way to pick a survivor. The old approach kept MAX(id) (the last row
  // inserted), but under the multi-link path that insert order was gh's search order — which
  // shared/pr.ts documents ranks nothing among candidates (recency is inverted by backports).
  // Silently keeping a coin-flip survivor is exactly the wrong-PR hazard this migration exists
  // to close; better to leave the case loudly unbound so the picker (gated on zero bindings —
  // see CaseWorkspace.tsx's handleModeChanged) offers again. A binding is a link plus a cached
  // repo path: no worktree and no case data is lost either way. The DELETE must run BEFORE the
  // index is created — openDb runs on every app start, and an existing database with several
  // bindings on one case would otherwise fail to open here for every user who has that state,
  // rather than being silently repaired.
  db.exec(
    `DELETE FROM pr_bindings WHERE case_id IN (
       SELECT case_id FROM pr_bindings GROUP BY case_id HAVING COUNT(*) > 1
     )`
  )
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS pr_bindings_one_per_case ON pr_bindings(case_id)`)
  // A database created before this migration still has the now-redundant non-unique index
  // (see the SCHEMA comment above) — drop it explicitly rather than leaving dead index upkeep
  // on every future insert/delete.
  db.exec(`DROP INDEX IF EXISTS idx_pr_bindings_case_id`)
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
  // Mode axis: which mode (see shared/modes.ts) a case is currently switched to. Sessions
  // are bound to the mode they were created under (sessions.mode); this column is what a
  // case-level mode switch actually flips (see caseService.setCaseMode).
  if (!caseCols.some((c) => c.name === 'active_mode')) {
    // SQL can't reference the TS DEFAULT_MODE constant (shared/modes.ts) — this literal
    // must be kept in sync with it by hand, same caveat as the sessions.mode migration below.
    db.exec(`ALTER TABLE cases ADD COLUMN active_mode TEXT NOT NULL DEFAULT 'investigation'`)
  }
  // Phase pin: the escape hatch for a phase with no artifact to derive it from (today only
  // `rca-drafted`). Everything else about a case's phase is derived at read time from
  // timestamps — see shared/casePhase.ts.
  if (!caseCols.some((c) => c.name === 'phase_pin')) {
    db.exec(`ALTER TABLE cases ADD COLUMN phase_pin TEXT`)
  }
  if (!caseCols.some((c) => c.name === 'phase_pinned_at')) {
    db.exec(`ALTER TABLE cases ADD COLUMN phase_pinned_at TEXT`)
  }
  // Collapse the legacy four-value status onto the two-value lifecycle. `analyzing` needs no
  // preservation: it re-derives from the evidence and turn rows that produced it. `rca-drafted`
  // cannot re-derive, so it becomes a pin stamped at updated_at — the closest thing to the
  // moment it was set that the row still remembers. Both statements are naturally idempotent:
  // after the first run no row matches. COALESCE keeps a pin an operator already set.
  db.exec(
    `UPDATE cases
        SET phase_pin = 'rca-drafted',
            phase_pinned_at = COALESCE(phase_pinned_at, updated_at),
            status = 'open'
      WHERE status = 'rca-drafted'`
  )
  db.exec(`UPDATE cases SET status = 'open' WHERE status = 'analyzing'`)
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
  // Mode axis: pins a session to 'investigation' or 'review' (see shared/modes.ts). This
  // snapshot (sessCols) is taken after the legacy UNIQUE(case_id) rebuild above, so the
  // guard is safe to reuse here without re-preparing PRAGMA table_info(sessions).
  if (!sessCols.some((c) => c.name === 'mode')) {
    // SQL can't reference the TS DEFAULT_MODE constant (shared/modes.ts) — this literal
    // must be kept in sync with it by hand.
    db.exec(`ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'investigation'`)
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
  // Review flavor (spec §6). All nullable: an investigation finding leaves them empty, and
  // mode is NOT stored — it joins from sessions.mode, which is already the session's binding.
  // diff_path/diff_line are the anchor parsed from the finding's first citation at write time,
  // so posting an inline PR comment never re-parses prose.
  const findingCols = db.prepare(`PRAGMA table_info(findings)`).all() as { name: string }[]
  if (!findingCols.some((c) => c.name === 'layer')) {
    db.exec(`ALTER TABLE findings ADD COLUMN layer TEXT`)
  }
  if (!findingCols.some((c) => c.name === 'severity')) {
    db.exec(`ALTER TABLE findings ADD COLUMN severity TEXT`)
  }
  if (!findingCols.some((c) => c.name === 'diff_path')) {
    db.exec(`ALTER TABLE findings ADD COLUMN diff_path TEXT`)
  }
  if (!findingCols.some((c) => c.name === 'diff_line')) {
    db.exec(`ALTER TABLE findings ADD COLUMN diff_line INTEGER`)
  }
  // Plan 4 (spec §6/§9). suggested_change is the fix the review agent proposed and is what
  // the Apply action implements; comment_url and pushed_sha are write-action OUTCOMES, kept
  // so a restart still shows which findings were already acted on.
  if (!findingCols.some((c) => c.name === 'suggested_change')) {
    db.exec(`ALTER TABLE findings ADD COLUMN suggested_change TEXT`)
  }
  if (!findingCols.some((c) => c.name === 'comment_url')) {
    db.exec(`ALTER TABLE findings ADD COLUMN comment_url TEXT`)
  }
  if (!findingCols.some((c) => c.name === 'pushed_sha')) {
    db.exec(`ALTER TABLE findings ADD COLUMN pushed_sha TEXT`)
  }
  // Plan 6 (review-action-ergonomics §1/§6). comment_body is the author-facing prose the agent
  // writes at record time — what the Post-comment button publishes without a model turn.
  // head_sha is the PR head the finding was recorded against, so the approval card and the
  // apply turn can say the PR has moved since.
  if (!findingCols.some((c) => c.name === 'comment_body')) {
    db.exec(`ALTER TABLE findings ADD COLUMN comment_body TEXT`)
  }
  if (!findingCols.some((c) => c.name === 'head_sha')) {
    db.exec(`ALTER TABLE findings ADD COLUMN head_sha TEXT`)
  }
  // RCA finding roles (root-cause/contributing/symptom/ruled-out/duplicate); null on findings
  // that haven't been triaged into an RCA yet.
  if (!findingCols.some((c) => c.name === 'role')) {
    db.exec(`ALTER TABLE findings ADD COLUMN role TEXT`)
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
  const distillCols = db.prepare(`PRAGMA table_info(distill_jobs)`).all() as { name: string }[]
  if (!distillCols.some((c) => c.name === 'prompt_hash')) {
    db.exec(`ALTER TABLE distill_jobs ADD COLUMN prompt_hash TEXT`)
  }
  const sessionCols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
  if (!sessionCols.some((c) => c.name === 'run_options')) {
    // Canonical array shape: [{"id":"effort","value":"xhigh"}]. NULL means "all defaults",
    // which is what lets a later default change still reach an existing session.
    db.exec(`ALTER TABLE sessions ADD COLUMN run_options TEXT`)
  }
  if (!sessionCols.some((c) => c.name === 'permission_mode')) {
    // Deliberately its own column, not folded into run_options: permission is
    // capability-derived, not model-derived, so it must survive a model with no
    // descriptors. NULL means "use settings.agent.defaultPermissionMode".
    db.exec(`ALTER TABLE sessions ADD COLUMN permission_mode TEXT`)
  }
  // Increment 2: what started a run. Named trigger_kind because TRIGGER is a SQLite keyword.
  // The DEFAULT is what makes every increment-1 row correct after this runs.
  const runCols = db.prepare(`PRAGMA table_info(routine_runs)`).all() as { name: string }[]
  if (!runCols.some((c) => c.name === 'trigger_kind')) {
    db.exec(`ALTER TABLE routine_runs ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'manual'`)
  }
  // Increment 3: inbox review state.
  if (!runCols.some((c) => c.name === 'reviewed_at')) {
    db.exec(`ALTER TABLE routine_runs ADD COLUMN reviewed_at TEXT`)
    // ONE-TIME, and the column guard is what makes it one-time. Every run recorded before this
    // migration has already been visible in Settings -> Recent runs since increment 1; letting
    // them all arrive as unreviewed would make the inbox's first act be to present a wall of
    // work the user has read. Rows with no finished_at are skipped deliberately: they are
    // stranded `running` rows, which reconcileInterruptedRuns turns into failed runs at boot,
    // and a run the app died inside of belongs in the inbox.
    db.exec(`UPDATE routine_runs SET reviewed_at = finished_at WHERE finished_at IS NOT NULL`)
  }
  if (!caseCols.some((c) => c.name === 'origin')) {
    db.exec(`ALTER TABLE cases ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'`)
    // Backfilled from the RUN TABLE, not from `slug LIKE 'routine-%'`. The prefix is a naming
    // convention that a human is free to use, and mislabelling their case would be permanent —
    // this migration is one-time. `routine_runs.case_slug` is the record of which cases a
    // routine actually wrote to.
    db.exec(
      `UPDATE cases SET origin = 'routine' WHERE slug IN (SELECT DISTINCT case_slug FROM routine_runs)`
    )
  }
  // Populate the FTS map tables for DBs that already held FTS rows before the
  // side-table fix landed (one-time; gated on the maps being empty).
  backfillFtsMaps(db)
  return db
}
