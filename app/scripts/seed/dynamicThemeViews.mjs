#!/usr/bin/env node
/**
 * Fixture for `cdp-dynamic-theme-views.mjs` (task 9, dynamic-theme CDP acceptance).
 *
 * Narrow and standalone, same reasoning as `findings-layout-fixture.mjs` and
 * `library-layout-fixture.mjs`: this shape is specific to one gate's assertions, and folding
 * it into `seed-test-home.mjs` would let a future change to that broad seed (for unrelated
 * reasons) silently drift this gate's fixture out from under it.
 *
 * What the acceptance needs, per the task-9 brief:
 *   - a P1 case (case-header accent, `railTier('Highest') === 'p1'`)
 *   - that same case's bound pull request carrying one FAILING check, so the PR companion
 *     rail (`PrCompanionSection`) renders `data-tier="p1"` too (`status.rollup === 'failing'`)
 *   - enough evidence rows to make the case's file list actually scroll (frame-time check)
 *
 * The PR binding points at a REAL pull request — JiaweiHan88/HiveMindTest#7 ("CI fixtures —
 * failing rollup", the same repo every other CDP/seed fixture in this codebase already uses —
 * because `PrCompanionSection` only renders while `mode === 'review'`, and entering review mode
 * makes `usePrStatuses` call the real `pr:statusRefresh` IPC on mount. `refreshPrStatuses`
 * (src/main/services/prStatusService.ts) unconditionally overwrites `pr_status_cache` with
 * whatever it fetches — including `unavailable` on a failed fetch (design decision 5 in that
 * file) — so ANY fabricated status_json seeded here would be clobbered within a second of the
 * case view mounting. Pointing at a real PR that genuinely has a failing check is what survives
 * that live refresh. (`required` is always reported `false` in this environment — HiveMindTest
 * has no branch protection, see prs.mjs's own comment — but `rollupOf()` treats "no required
 * checks configured" as "every check gates", so a real failing check still produces `failing`
 * without needing a real required flag.) The row this script seeds is only a placeholder so the
 * UI has something to show for the ~1s before that live refresh lands.
 *
 * `repo_path` is left NULL — nothing this gate exercises (viewing the rail, reading its
 * `data-tier`) dereferences it, and skipping a real git clone keeps this fixture cheap and
 * network-free apart from the one live PR status fetch review mode itself triggers.
 *
 * Usage:
 *   ARGUS_HOME=/path/to/home node scripts/seed/dynamicThemeViews.mjs
 *
 * Requires an ARGUS_HOME whose argus.db has already been through the app's startup
 * migrations (boot the app once against it first — see the other *-fixture.mjs scripts for
 * why: a never-opened db has none of `cases.jira_priority` / `cases.active_mode` /
 * `sessions.mode`, all added by db.ts migrations, not by this script).
 *
 * Idempotent: re-running replaces the case's session, PR binding/cache, and evidence rows.
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.ARGUS_HOME
if (!HOME) throw new Error('ARGUS_HOME is required — refusing to guess a home to write into')
const defaultHome = path.join(os.homedir(), 'Argus')
if (path.resolve(HOME) === path.resolve(defaultHome)) {
  throw new Error(`refusing to seed the default home (${defaultHome})`)
}

export const SLUG = 'DTV-1-p1'
const OWNER = 'JiaweiHan88'
const REPO = 'HiveMindTest'
const PR_NUMBER = 7
/** How many evidence rows to seed — enough that CaseFiles' `<ul overflow-y-auto>` genuinely
 *  scrolls past a viewport-sized page, which is what the frame-time check (task-9 brief #6)
 *  needs: without real scroll distance, "scroll and measure rAF" measures nothing. */
const EVIDENCE_COUNT = 200

const dbPath = path.join(HOME, 'argus.db')
if (!fs.existsSync(dbPath)) {
  console.error(`no argus.db at ${dbPath} — boot the app once against this ARGUS_HOME first`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON')

// Preflight: the migrated columns this fixture writes. Same shape as seed-test-home.mjs's
// own preflight — fail with a clear message rather than a raw SQLITE_ERROR mid-write.
const REQUIRED = {
  cases: ['jira_priority', 'active_mode'],
  sessions: ['mode', 'driver_kind']
}
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

// ── 1. the case: P1 priority, parked in review mode (required for PrCompanionSection to
// render at all — see the module doc comment above). ──
db.prepare(
  `INSERT OR IGNORE INTO cases (slug, title, status, tags, created_at, updated_at)
   VALUES (?, ?, 'open', '[]', ?, ?)`
).run(SLUG, 'Dynamic theme views fixture', now, now)
const caseId = db.prepare('SELECT id FROM cases WHERE slug = ?').get(SLUG).id
db.prepare(`UPDATE cases SET jira_priority = 'Highest', active_mode = 'review' WHERE id = ?`).run(
  caseId
)

// ── 2. a review-mode session, so CaseWorkspace's session bootstrap (which falls back to
// `list[0]` when nothing matches `activeMode`) lands on one that actually matches, and so
// the case doesn't open to a session-list crash on an empty list. ──
db.prepare('DELETE FROM sessions WHERE case_id = ?').run(caseId)
db.prepare(
  `INSERT INTO sessions (case_id, driver_kind, title, turn_count, created_at, updated_at, mode)
   VALUES (?, 'claude-agent-sdk', 'review run', 1, ?, ?, 'review')`
).run(caseId, now, now)

// ── 3. PR binding + a placeholder cached status. The real shape of PR #7 (fetched live at
// authoring time): a FAILURE check (`big-log`) and a CANCELLED one alongside several SUCCESS/
// SKIPPED — this mirrors `statusFromGh()`/`bucketOfCheckRun()` in scripts/seed/prs.mjs closely
// enough to be visually right for the ~1s window before the real refresh replaces it. ──
db.prepare('DELETE FROM pr_bindings WHERE case_id = ?').run(caseId)
db.prepare('DELETE FROM pr_status_cache WHERE case_id = ?').run(caseId)
const url = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`
db.prepare(
  `INSERT INTO pr_bindings (case_id, repo_path, owner, repo, number, url, source, detected_at)
   VALUES (?, NULL, ?, ?, ?, ?, 'manual', ?)`
).run(caseId, OWNER, REPO, PR_NUMBER, url, now)
const placeholderStatus = {
  owner: OWNER,
  repo: REPO,
  number: PR_NUMBER,
  url,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'UNKNOWN',
  mergeStateStatus: 'UNKNOWN',
  reviewDecision: null,
  rollup: 'failing',
  checks: [
    { name: 'ci / big-log', bucket: 'fail', required: false, url: null, jobId: null },
    { name: 'verify-b / verify', bucket: 'fail', required: false, url: null, jobId: null },
    { name: 'verify-a / verify', bucket: 'cancelled', required: false, url: null, jobId: null },
    { name: 'ci / unit-tests', bucket: 'pass', required: false, url: null, jobId: null },
    { name: 'ci / lint', bucket: 'pass', required: false, url: null, jobId: null }
  ],
  fetchedAt: now,
  error: null
}
db.prepare(`INSERT INTO pr_status_cache (case_id, fetched_at, status_json) VALUES (?, ?, ?)`).run(
  caseId,
  now,
  JSON.stringify(placeholderStatus)
)

// ── 4. evidence rows, review-scoped (`artifacts/` prefix — see shared/evidenceScope.ts),
// so they show up in the "Code review artifacts" list CaseFiles renders while this case sits
// in review mode. Rows only — no files on disk. Nothing this gate exercises opens one, and
// the app's own listEvidence() reads purely from the DB row (rel_path/size/artifactType/meta),
// never the filesystem, for the list view itself. ──
db.prepare('DELETE FROM evidence WHERE case_id = ?').run(caseId)
const insEvidence = db.prepare(
  `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
   VALUES (?, ?, ?, 'text', ?, 'upload', '{}', ?)`
)
for (let i = 0; i < EVIDENCE_COUNT; i++) {
  const n = String(i).padStart(4, '0')
  insEvidence.run(
    caseId,
    `artifacts/fixture-review-note-${n}.md`,
    // a stable, distinct fake sha per row — good enough as a UNIQUE-safe filler, never verified
    `${'0'.repeat(56)}${n}`,
    120 + i,
    new Date(Date.now() - i * 1000).toISOString()
  )
}

console.log(
  JSON.stringify(
    { slug: SLUG, caseId, pr: { owner: OWNER, repo: REPO, number: PR_NUMBER }, EVIDENCE_COUNT },
    null,
    2
  )
)
db.close()
