#!/usr/bin/env node
/**
 * Fixture for `cdp-composer-run-options.mjs` (Task 15, composer run-options responsive
 * collapse). Narrow and standalone, same reasoning as `findings-layout-fixture.mjs` and
 * `scripts/seed/dynamicThemeViews.mjs`: this shape is specific to one gate's assertions, and
 * folding it into `seed-test-home.mjs` would let an unrelated future change to that broad seed
 * silently drift this gate's fixture out from under it.
 *
 * Seeds one case with a single `claude-agent-sdk` session pinned to instance `claude-default`
 * and model `claude-sonnet-5` — an effort-capable model (`supportsEffort`, levels through
 * `xhigh`) both in the live CLI catalog AND in `catalog.ts`'s `STATIC_FALLBACK`, so the
 * Reasoning / Context Window / Ultracode descriptors render in the composer regardless of
 * whether the machine driving this gate can actually reach the network — see that file's
 * `STATIC_FALLBACK` entry for `claude-sonnet-5`. `run_options` starts NULL (nothing selected
 * yet — every descriptor reads its own default).
 *
 * Usage:
 *   ARGUS_HOME=/path/to/home node scripts/composer-run-options-fixture.mjs
 *
 * Requires an ARGUS_HOME whose argus.db has already been through the app's startup
 * migrations (boot the app once against this ARGUS_HOME first, then quit it before running
 * this script — a fresh, never-opened db has none of `sessions.instance_id` / `.model` /
 * `.mode` / `.run_options`; those are added by db.ts's migrations, not by this script).
 *
 * Idempotent: re-running against the same ARGUS_HOME replaces the case's session.
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.ARGUS_HOME
if (!HOME) {
  console.error('set ARGUS_HOME to a directory with an already-migrated argus.db')
  process.exit(1)
}
const defaultHome = path.join(os.homedir(), 'Argus')
if (path.resolve(HOME) === path.resolve(defaultHome)) {
  console.error(`refusing to seed the default home (${defaultHome})`)
  process.exit(1)
}

export const SLUG = 'CRO-1-composer-options'
export const CASE_TITLE = 'Composer run options fixture'

const dbPath = path.join(HOME, 'argus.db')
if (!fs.existsSync(dbPath)) {
  console.error(`no argus.db at ${dbPath} — boot the app once against this ARGUS_HOME first`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON')

// Preflight: the migrated columns this fixture writes. Same shape as the other *-fixture.mjs
// scripts' own preflights — fail with a clear message rather than a raw SQLITE_ERROR mid-write.
const REQUIRED = { sessions: ['driver_kind', 'instance_id', 'model', 'mode', 'run_options'] }
for (const [table, cols] of Object.entries(REQUIRED)) {
  const have = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)
  for (const col of cols) {
    if (!have.includes(col)) {
      console.error(
        `argus.db is not migrated (${table}.${col} missing)\nboot the app once first:\n  ARGUS_HOME=${HOME} npm run dev`
      )
      process.exit(1)
    }
  }
}

const now = new Date().toISOString()

// ── 1. the case, parked in investigation mode (the default — matches the seeded session's own
// `mode` below, so CaseWorkspace's mode-reconciliation lands on it instead of falling through
// to session-list[0] by luck). ──
db.prepare(
  `INSERT OR IGNORE INTO cases (slug, title, status, tags, created_at, updated_at)
   VALUES (?, ?, 'open', '[]', ?, ?)`
).run(SLUG, CASE_TITLE, now, now)
const caseId = db.prepare('SELECT id FROM cases WHERE slug = ?').get(SLUG).id
db.prepare(`UPDATE cases SET active_mode = 'investigation', updated_at = ? WHERE id = ?`).run(
  now,
  caseId
)

// ── 2. one Claude session, pinned to a model that reports effort support — this is what makes
// descriptorsFor() (shared/runOptions.ts) emit the Reasoning/Context Window/Ultracode
// descriptors the composer renders. run_options is left NULL: every descriptor starts at its
// own default, and the gate's own "select Ultracode" step is what first writes to it. ──
db.prepare('DELETE FROM sessions WHERE case_id = ?').run(caseId)
db.prepare(
  `INSERT INTO sessions
     (case_id, driver_kind, instance_id, model, title, turn_count, created_at, updated_at, mode)
   VALUES (?, 'claude-agent-sdk', 'claude-default', 'claude-sonnet-5', 'composer options run', 0, ?, ?, 'investigation')`
).run(caseId, now, now)
const sessionId = db.prepare('SELECT id FROM sessions WHERE case_id = ?').get(caseId).id

console.log(JSON.stringify({ slug: SLUG, caseTitle: CASE_TITLE, caseId, sessionId }, null, 2))
db.close()
