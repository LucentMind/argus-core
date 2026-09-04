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
  ticket_provider TEXT NOT NULL DEFAULT 'jira',
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
-- The legacy contentful pair -- evidence_fts (fts5) and its evidence_fts_map side table --
-- is INTENTIONALLY NOT DECLARED HERE, and must not be added back.
--
-- openDb execs this schema on every single start. While the CREATEs lived here, the boot
-- after finalizeEvidenceIndexMigration (evidenceIndexMigration.ts) dropped the pair simply
-- recreated both, empty: the finalize guard ("do the legacy tables exist?") passed again,
-- "how many legacy rows remain?" answered 0, and finalize re-ran DROP/DROP/VACUUM at every
-- launch, forever -- a full rewrite of a multi-gigabyte database on each start. Not
-- declaring them is what makes the drop stick.
--
-- Consequences, all deliberate:
--   * A fresh install never has the pair at all. Every legacy read is probe-guarded
--     (ftsIndex.legacyEvidenceIndexExists), so nothing runs and nothing throws.
--   * An OLDER database still HAS the pair, created by a previous release, with its rows.
--     The migration is now the only thing that removes them, and it runs once.
--   * Anything that touches evidence_fts / evidence_fts_map must therefore probe first;
--     see ftsIndex.ts and search.ts. Their historical column list lives only in the test
--     helper __tests__/legacyFts.ts, which stands in for that older release's schema.
-- Contentless replacement for evidence_fts. FTS5's default (contentful) mode keeps a
-- verbatim copy of every indexed line in its _content shadow table on top of the
-- inverted index, which on a real 50-case install cost 36.7 GB — a second copy of
-- evidence files that already exist on disk under caseDir(). Storing only the index
-- costs 0.38x the raw text instead of 1.40x (measured).
--
-- content='' means NO column value can ever be read back: SELECT content, and
-- snippet(), return NULL rather than raising. Locators therefore live in
-- evidence_index_map, and snippets are rendered from the file (services/snippet.ts).
-- contentless_delete=1 is what makes DELETE ... WHERE rowid = ? legal, which every
-- delete helper in ftsIndex.ts relies on. detail stays full: detail=column/none raise
-- on phrase and NEAR queries.
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_index USING fts5(
  content, content='', contentless_delete=1
);
CREATE TABLE IF NOT EXISTS evidence_index_map (
  fts_rowid   INTEGER PRIMARY KEY,
  evidence_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_index_map_evidence_id
  ON evidence_index_map(evidence_id);
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
  finished_at TEXT,
  -- v2: what this row distills. Every read path that must only ever see a case's own
  -- distill history filters on kind='case' (queue.statusFor, queue.listRuns, queue.retry's
  -- raw.kind !== 'case' guard, needsDistillRun via statusFor, evalExport's job selection —
  -- both the default MAX(id) subselect and the explicit-id path's per-row kind check,
  -- usage.ts's distillationStats) so a later kind (e.g. 'reject-digest') can share this table
  -- without being mistaken for a case job.
  kind TEXT NOT NULL DEFAULT 'case',
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  prompt_chars INTEGER,
  turn_count INTEGER,
  tool_call_count INTEGER,
  trajectory_json TEXT,
  dropped_json TEXT,
  -- v3: per-stage records (PipelineStages) from the staged pipeline, as JSON. NULL for a v2
  -- single-call run, and for any row written before v3 existed.
  stages_json TEXT,
  -- A comparison run: the full pipeline ran, staging did not. Every DB READ of "this case's
  -- distillation state" filters dry_run = 0 (queue.statusFor, needsDistillRun via statusFor,
  -- evalExport's job selection, usage.ts's distillationStats) — queue.listRuns is the one
  -- reader that deliberately does NOT filter it (the run picker compares a dry run against a
  -- real one on purpose). runDetail.readRunDetail is a second unfiltered reader, but it is
  -- id-keyed (SELECT ... WHERE id = ?), not "latest row for this case" — an id-keyed read has
  -- no "which row is this case's real state" question to get wrong, so it needs no dry_run
  -- filter. It's reached only via listRuns (already kind='case'-filtered), never directly by
  -- slug.
  --
  -- The BROADCAST path (DistillQueue.emit(), fired on every case-job state transition) is not
  -- filtered by dry_run either — a dry run's own queued/running/terminal states all go out over
  -- IPC like any other job's, which is by design: the chip has to show and cancel a dry run
  -- while it's actually in flight. The renderer's useDistillJob hook is what keeps this from
  -- leaking into a resting read: once a TRACKED dry row reaches a terminal state, the hook
  -- re-fetches status(slug) (going through statusFor, hence the filter above) instead of
  -- adopting the dry broadcast directly. New DB readers of this table: grep for dry_run = 0
  -- across this list and add yourself, so this comment doesn't go stale again.
  dry_run INTEGER NOT NULL DEFAULT 0,
  -- Which case-distill pipeline ran this row: 'v2' | 'v3'. Stamped in runJob when the row flips
  -- to 'running' (the flag is read per call, so enqueue time would be a guess), NULL until then
  -- and NULL on every row written before this column existed — pipelineOf() falls back to
  -- stages_json presence for those. retry() clears it so the re-run re-stamps.
  pipeline TEXT
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
  template_snapshot TEXT,
  dropped_sections TEXT,
  meta_snapshot TEXT,
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
-- Jira tickets a case reads evidence FROM but is not bound to (spec 2026-08-18-case-source-tickets).
-- cases.jira_key remains the one ticket the case IS; these are sources only, never a post target.
-- No separate FK index: PRIMARY KEY(case_id, jira_key) already leads with case_id, so the cascade
-- lookup is indexed -- same reasoning as pr_bindings above.
CREATE TABLE IF NOT EXISTS case_jira_links (
  case_id        INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  jira_key       TEXT NOT NULL,
  role           TEXT NOT NULL,
  added_at       TEXT NOT NULL,
  attachment_ids TEXT NOT NULL DEFAULT '[]',
  deselected_ids TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (case_id, jira_key)
);
-- Which skill sibling files a human has actually reviewed on THIS machine, and the bytes they
-- reviewed. Increment 3's run gate compares the hash of the file about to execute against this
-- row: equal = reviewed, different = changed since review, absent = never reviewed here (an
-- imported or HiveMind-pulled skill). PK is (skill, rel_path) — one current review per file, so
-- re-reviewing replaces rather than accumulates.
CREATE TABLE IF NOT EXISTS skill_asset_reviews (
  skill       TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  reviewed_by TEXT,
  origin      TEXT NOT NULL,
  PRIMARY KEY (skill, rel_path)
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
-- evidence_fts_map is deliberately absent here, together with evidence_fts -- see the
-- comment beside evidence_index above for why re-declaring either would resurrect the
-- VACUUM-every-boot bug. evidence_index_map (declared above) is its replacement.
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
-- NULLABLE (fix pass, increment 5): a SCOPED run never opens a routine-<id> case — its items
-- open their own cases, recorded on routine_run_items instead — so this column has nothing
-- true to hold for that run. NULL means exactly that, not "not known yet".
CREATE TABLE IF NOT EXISTS routine_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id TEXT NOT NULL,
  case_slug TEXT,
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
-- Increment 5: one row per ITEM a run processed. This is what makes "per-item errors never kill
-- a run" a host-observed fact rather than something the model reports about its own work.
-- ON DELETE CASCADE because an item row without its run is unreadable — every consumer joins
-- through run_id.
CREATE TABLE IF NOT EXISTS routine_run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES routine_runs(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  case_slug TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  suggestion TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_routine_run_items_run ON routine_run_items(run_id);
-- Not speculative: the jira-jql selection path asks "which keys has this routine already
-- attempted", which scans by key across every run of that routine.
CREATE INDEX IF NOT EXISTS idx_routine_run_items_key ON routine_run_items(item_key);
-- Increment 5: where a jira-jql routine's next query starts. Persisted for the same reason
-- routine_anchors is — an in-memory cursor is re-derived at every launch, which either replays
-- work already done or skips work never done, both silently.
CREATE TABLE IF NOT EXISTS routine_cursors (
  routine_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

export function openDb(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode = WAL;`)
  // WAL + NORMAL is SQLite's recommended pairing: the WAL is synced at checkpoint, not on every
  // commit. Durable against an app crash; only an OS crash or power loss can drop the last
  // committed transactions, and the file can never be corrupted by it. Under the default FULL,
  // every autocommit statement fsyncs — openDb alone is ~82 of them — which is what made each
  // DB-fixture test cost ~1.7s on GitHub's Windows runners (fsync ≈ 20ms there) and the
  // Windows CI job run 25-30 min against macOS's 8. Measured locally: 80 autocommits 29.5ms
  // under FULL, 3.2ms under NORMAL.
  db.exec(`PRAGMA synchronous = NORMAL;`)
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
  // Case archiving. All nullable with no backfill: NULL means "never archived" / "never
  // opened", which is exactly true of every pre-existing row. archive_sha256 is the
  // manifest hash recorded at archive time, so a later restore can tell a bundle that was
  // swapped or truncated on disk from the one this case actually produced.
  if (!caseCols.some((c) => c.name === 'archived_at')) {
    db.exec(`ALTER TABLE cases ADD COLUMN archived_at TEXT`)
  }
  if (!caseCols.some((c) => c.name === 'archive_path')) {
    db.exec(`ALTER TABLE cases ADD COLUMN archive_path TEXT`)
  }
  if (!caseCols.some((c) => c.name === 'archive_sha256')) {
    db.exec(`ALTER TABLE cases ADD COLUMN archive_sha256 TEXT`)
  }
  // Written when a case is opened in the UI. Reading a reference case is activity even
  // though nothing changes, and nothing else in the schema records it — without this, the
  // cases most worth keeping live are exactly the ones that look idle. repo_usage is the
  // existing precedent for recording use that is not modification.
  if (!caseCols.some((c) => c.name === 'last_opened_at')) {
    db.exec(`ALTER TABLE cases ADD COLUMN last_opened_at TEXT`)
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
  // Every pre-existing case is a Jira case by construction, so the column default is also the
  // correct backfill — no UPDATE is needed. `ticket_provider` is the ONLY authority on which
  // provider a case belongs to; nothing infers it from `jira_key`'s shape.
  if (!caseCols.some((c) => c.name === 'ticket_provider')) {
    db.exec(`ALTER TABLE cases ADD COLUMN ticket_provider TEXT NOT NULL DEFAULT 'jira'`)
  }
  // case_jira_links shipped one increment earlier, so a user's database can already have the
  // table without this column — CREATE TABLE IF NOT EXISTS above would silently skip it.
  const linkCols = db.prepare(`PRAGMA table_info(case_jira_links)`).all() as { name: string }[]
  if (!linkCols.some((c) => c.name === 'deselected_ids')) {
    db.exec(`ALTER TABLE case_jira_links ADD COLUMN deselected_ids TEXT NOT NULL DEFAULT '[]'`)
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
  // Finding retraction. `review_reason` is why the finding was rejected or withdrawn;
  // `review_actor` is WHO did it ('human' | 'agent'), which is what lets one `rejected`
  // state carry two authorities without adding a fourth ReviewState value. NULL on every
  // pre-existing row: until this change the agent had no way to reject anything, so every
  // rejection on disk is a human's. Nothing compares against the literal 'human', so a
  // NULL actor simply takes the same path a human reject does — it is never mapped to it.
  if (!findingCols.some((c) => c.name === 'review_reason')) {
    db.exec(`ALTER TABLE findings ADD COLUMN review_reason TEXT`)
  }
  if (!findingCols.some((c) => c.name === 'review_actor')) {
    db.exec(`ALTER TABLE findings ADD COLUMN review_actor TEXT`)
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
  // v2 job columns (kind, usage, trajectory, dropped) — see the CREATE TABLE comment above.
  const addDistill = (name: string, ddl: string): void => {
    if (!distillCols.some((c) => c.name === name))
      db.exec(`ALTER TABLE distill_jobs ADD COLUMN ${ddl}`)
  }
  addDistill('kind', `kind TEXT NOT NULL DEFAULT 'case'`)
  addDistill('input_tokens', `input_tokens INTEGER`)
  addDistill('output_tokens', `output_tokens INTEGER`)
  addDistill('cost_usd', `cost_usd REAL`)
  addDistill('duration_ms', `duration_ms INTEGER`)
  addDistill('prompt_chars', `prompt_chars INTEGER`)
  addDistill('turn_count', `turn_count INTEGER`)
  addDistill('tool_call_count', `tool_call_count INTEGER`)
  addDistill('trajectory_json', `trajectory_json TEXT`)
  addDistill('dropped_json', `dropped_json TEXT`)
  addDistill('stages_json', `stages_json TEXT`)
  addDistill('dry_run', `dry_run INTEGER NOT NULL DEFAULT 0`)
  addDistill('pipeline', 'pipeline TEXT')
  const rcaJobCols = db.prepare(`PRAGMA table_info(rca_jobs)`).all() as { name: string }[]
  if (!rcaJobCols.some((c) => c.name === 'template_snapshot')) {
    db.exec(`ALTER TABLE rca_jobs ADD COLUMN template_snapshot TEXT`)
  }
  if (!rcaJobCols.some((c) => c.name === 'dropped_sections')) {
    // The per-report section ids the user dropped at confirm time, as
    // `{"exec":[…],"tech":[…]}`. NULL means "nothing dropped", which is what lets a row
    // written before this column still re-render its confirmed bytes.
    db.exec(`ALTER TABLE rca_jobs ADD COLUMN dropped_sections TEXT`)
  }
  if (!rcaJobCols.some((c) => c.name === 'meta_snapshot')) {
    // The exact `caseMeta` (title/jiraKey/slug/…) used to render the two confirmed report
    // files, as JSON. Both fields are mutable after confirm — most commonly linking Jira,
    // which is required before the report can be posted at all — so re-rendering under LIVE
    // case meta would make an untouched report falsely read as hand-edited. NULL means a row
    // confirmed before this column existed; handEditedReports falls back to live case meta
    // for those, which reproduces today's behaviour rather than a new one.
    db.exec(`ALTER TABLE rca_jobs ADD COLUMN meta_snapshot TEXT`)
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

  // Fix pass (increment 5): case_slug loses its NOT NULL — a scoped run's row must not claim a
  // `routine-<id>` case it never creates (that case is what the UI's "Open case" button used to
  // point at for a routine that has only ever run scoped). SQLite cannot drop a column
  // constraint via ALTER, so this rebuilds the table once, gated on the constraint still being
  // there. Runs AFTER the trigger_kind / reviewed_at migrations so every column already exists
  // to copy across.
  //
  // ORDERING CONSTRAINT: any future `ALTER TABLE routine_runs ADD COLUMN ...` must be placed
  // BELOW this block, never above it. This rebuild only re-fires on a database that still has
  // the old NOT NULL case_slug (the `runCaseSlugCol?.notnull === 1` guard below), and it copies
  // across only the columns it names explicitly — a column added above this block would be
  // silently dropped by the rebuild on exactly the databases that still need it.
  //
  // FK-CASCADE TRAP: `routine_run_items.run_id` REFERENCES routine_runs(id) ON DELETE CASCADE,
  // and openDb runs `PRAGMA foreign_keys = ON` above. SQLite's DROP TABLE performs an implicit
  // DELETE FROM, which fires FK actions — so DROP TABLE routine_runs below would cascade-delete
  // every routine_run_items row for every run in the database, silently. PRAGMA foreign_keys is
  // documented as a no-op while a transaction is active, so it MUST be toggled OFF before BEGIN
  // and back ON after COMMIT, never inside the transaction (this is SQLite's documented
  // table-rebuild procedure: https://sqlite.org/lang_altertable.html#otheralter). The
  // foreign_key_check afterward turns a broken reference into a loud failure instead of a silent
  // dangling row.
  const runCaseSlugCol = (
    db.prepare(`PRAGMA table_info(routine_runs)`).all() as { name: string; notnull: number }[]
  ).find((c) => c.name === 'case_slug')
  if (runCaseSlugCol?.notnull === 1) {
    db.exec(`PRAGMA foreign_keys = OFF;`)
    db.exec(`BEGIN;
      CREATE TABLE routine_runs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        routine_id TEXT NOT NULL,
        case_slug TEXT,
        session_id INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary TEXT,
        error TEXT,
        trigger_kind TEXT NOT NULL DEFAULT 'manual',
        reviewed_at TEXT
      );
      INSERT INTO routine_runs_new
        (id, routine_id, case_slug, session_id, status, started_at, finished_at, summary, error,
         trigger_kind, reviewed_at)
        SELECT id, routine_id, case_slug, session_id, status, started_at, finished_at, summary,
               error, trigger_kind, reviewed_at FROM routine_runs;
      DROP TABLE routine_runs;
      ALTER TABLE routine_runs_new RENAME TO routine_runs;
      CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id);
    COMMIT;`)
    db.exec(`PRAGMA foreign_keys = ON;`)
    const fkViolations = db.prepare(`PRAGMA foreign_key_check`).all()
    if (fkViolations.length > 0) {
      throw new Error(
        `routine_runs rebuild left dangling foreign keys: ${JSON.stringify(fkViolations)}`
      )
    }
  }

  // Increment 3: case origin.
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

  // Increment 5: draft review state on a case an item produced. Nullable with NO backfill and
  // no 'ready' value — NULL is already the correct answer for every case that exists, so the
  // migration is the column and nothing else. A two-valued column would have to be kept
  // consistent with `origin` forever; a nullable one cannot disagree with itself.
  if (!caseCols.some((c) => c.name === 'review_state')) {
    db.exec(`ALTER TABLE cases ADD COLUMN review_state TEXT`)
  }
  // `rca_jobs.case_slug` carries no FK (see the SCHEMA above), and `deleteCase` did not clean
  // the table until this migration's sibling fix — so existing databases hold job rows, report
  // bodies (`raw_output`) and template snapshots for slugs whose case and case directory are
  // both long gone. Nothing can read them: every rca_jobs read is keyed by a slug the user has
  // to open a live case to reach. Purged unconditionally rather than one-time-gated, matching
  // the pr_bindings repair above — once deleteCase does its job this is a no-op on a table with
  // at most a handful of rows per case. Deliberately NOT extended to repo_usage/routine_runs:
  // those two document their surviving-the-case behaviour as intentional.
  db.exec(`DELETE FROM rca_jobs WHERE case_slug NOT IN (SELECT slug FROM cases)`)
  // Session rewind + fork (spec 2026-09-04). All nullable: no backfill, no rebuild.
  const turnCols2 = db.prepare(`PRAGMA table_info(turns)`).all() as { name: string }[]
  const addTurn = (name: string, ddl: string): void => {
    if (!turnCols2.some((c) => c.name === name)) db.exec(`ALTER TABLE turns ADD COLUMN ${ddl}`)
  }
  addTurn('rewound_at', `rewound_at TEXT`)
  addTurn('rewound_to_turn_id', `rewound_to_turn_id INTEGER`)
  addTurn('provider_anchor_id', `provider_anchor_id TEXT`)
  const sessCols2 = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
  const addSess = (name: string, ddl: string): void => {
    if (!sessCols2.some((c) => c.name === name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`)
  }
  addSess('forked_from_session_id', `forked_from_session_id INTEGER`)
  addSess('forked_at_turn_id', `forked_at_turn_id INTEGER`)
  addSess('forked_inherited_turns', `forked_inherited_turns INTEGER`)
  addSess('pre_rewind_cursor', `pre_rewind_cursor TEXT`)
  // Populate the FTS map tables for DBs that already held FTS rows before the
  // side-table fix landed (one-time; gated on the maps being empty).
  backfillFtsMaps(db)
  return db
}
