#!/usr/bin/env node
/**
 * Seeds an ARGUS_HOME with a case that hits every visual worst case
 * `findings-layout-probe.mjs` measures:
 *   - all three severities (critical/major/minor) + one unflavored finding
 *   - the longest layer label ("Design conformance")
 *   - a REAL materialized PR worktree + binding, so the "code moved" badge is driven by an
 *     actual `git rev-parse HEAD` mismatch rather than a fabricated sha the app never checks
 *   - one finding carrying ALL THREE status badges at once (code moved + commented + pushed
 *     sha) — the true worst-case row, the one that must not wrap at FINDINGS_MIN_WIDTH. The
 *     footer-measurement gap on the branch this fixture supports slipped through precisely
 *     because an earlier fixture never manufactured this row.
 *   - one finding with a body, so expanded-card block order can be measured
 *
 * Usage:
 *   ARGUS_HOME=/path/to/home node scripts/findings-layout-fixture.mjs [SLUG]
 *
 * Requires an ARGUS_HOME whose argus.db has already been through the app's startup
 * migrations (boot the app once against this ARGUS_HOME first, then quit it before running
 * this script — a fresh, never-opened db has no `findings.layer`/`severity`/... columns; those
 * are added by db.ts's migrations, not by this script). Requires `git` on PATH.
 *
 * Idempotent: re-running against the same ARGUS_HOME replaces the case's findings, PR
 * binding, and worktree rather than duplicating them.
 */
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.ARGUS_HOME
if (!HOME) {
  console.error('set ARGUS_HOME to a directory with an already-migrated argus.db')
  process.exit(1)
}
const SLUG = process.argv[2] || 'T7-LAYOUT'
const PR_NUMBER = 42
const REPO_PATH = 'widget' // display name only — path.basename() of this is what the app shows

const dbPath = path.join(HOME, 'argus.db')
if (!fs.existsSync(dbPath)) {
  console.error(`no argus.db at ${dbPath} — boot the app once against this ARGUS_HOME first`)
  process.exit(1)
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

// ── 1. Materialize a real PR worktree at the exact path casePrWorktreeDir() computes
// (`<ARGUS_HOME>/worktrees/<repo>-<slug>-pr<n>`, see src/main/services/prWorktree.ts and
// workspaces.ts). prWorktreeHead() shells out to `git rev-parse HEAD` in this directory, so a
// real commit here is what makes the "code moved" badge come from the same code path a live
// review session uses, not a probe-only shortcut. ──
const worktreeDir = path.join(HOME, 'worktrees', `${REPO_PATH}-${SLUG}-pr${PR_NUMBER}`)
fs.rmSync(worktreeDir, { recursive: true, force: true })
fs.mkdirSync(path.join(worktreeDir, 'src'), { recursive: true })
fs.writeFileSync(path.join(worktreeDir, 'src', 'rateLimiter.js'), '// fixture file\n')
git(worktreeDir, 'init', '-q')
git(worktreeDir, 'config', 'user.email', 'probe@example.com')
git(worktreeDir, 'config', 'user.name', 'Findings Probe')
git(worktreeDir, 'add', '-A')
git(worktreeDir, 'commit', '-q', '-m', 'fixture head')
const FRESH_HEAD = git(worktreeDir, 'rev-parse', 'HEAD')
// Any sha that isn't FRESH_HEAD renders "code moved" — findings.head_sha is stored text and
// never dereferenced, so this needn't resolve to a real commit.
const STALE_HEAD = 'b994f1a61e2ea27c9c0ae9ec8a94f8a3d4302427'
if (STALE_HEAD === FRESH_HEAD) throw new Error('unlucky sha collision — change STALE_HEAD')

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON')
const now = new Date().toISOString()

// ── 2. Case + a review-mode session. Findings are case-scoped in the DB but mode-scoped on
// screen via sessions.mode (findings.ts joins it in) — a review session is what makes these
// findings show up under Review, with comment+apply buttons instead of thumbs. ──
db.prepare(
  `INSERT OR IGNORE INTO cases (slug, title, status, tags, created_at, updated_at)
   VALUES (?, ?, 'open', '[]', ?, ?)`
).run(SLUG, 'Findings layout probe', now, now)
const caseId = db.prepare('SELECT id FROM cases WHERE slug = ?').get(SLUG).id

db.prepare(
  `INSERT INTO sessions (case_id, driver_kind, title, turn_count, created_at, updated_at, mode)
   VALUES (?, 'claude-agent-sdk', 'review run', 1, ?, ?, 'review')`
).run(caseId, now, now)
const sessionId = db
  .prepare('SELECT id FROM sessions WHERE case_id = ? ORDER BY id DESC LIMIT 1')
  .get(caseId).id

// ── 3. PR binding, pointing at the real worktree above. ──
db.prepare('DELETE FROM pr_bindings WHERE case_id = ?').run(caseId)
db.prepare(
  `INSERT INTO pr_bindings (case_id, repo_path, owner, repo, number, url, source, detected_at)
   VALUES (?, ?, 'acme', 'widget', ?, ?, 'manual', ?)`
).run(caseId, REPO_PATH, PR_NUMBER, `https://github.com/acme/widget/pull/${PR_NUMBER}`, now)

// ── 4. Findings: every worst case in one fixture. ──
db.prepare('DELETE FROM findings WHERE case_id = ?').run(caseId)

const findings = [
  {
    summary:
      'Valid admin token leaked to logs in plaintext on every request when a legacy token is configured',
    layer: 'security',
    severity: 'critical',
    diff_path: 'widget/src/rateLimiter.js',
    diff_line: 57,
    head_sha: FRESH_HEAD,
    comment_url: null,
    pushed_sha: null,
    body: null,
    state: 'rejected'
  },
  {
    // The true worst case: the longest layer label ("Design conformance") AND all three
    // status badges (code moved + commented + pushed sha) share this one row.
    summary: 'Unrelated probe file src/notes.js included in the PR',
    layer: 'design-conformance',
    severity: 'minor',
    diff_path: 'widget/src/notes.js',
    diff_line: 1,
    head_sha: STALE_HEAD,
    comment_url: 'https://github.com/acme/widget/pull/42#discussion_r9',
    pushed_sha: 'fedcba9876543210fedcba9876543210fedcba98',
    body: null,
    state: 'pending'
  },
  {
    summary: 'No test coverage for the burst allowance or the legacy-token fallback',
    layer: 'tests',
    severity: 'major',
    diff_path: 'widget/test/rateLimiter.test.js',
    diff_line: 12,
    head_sha: STALE_HEAD,
    comment_url: null,
    pushed_sha: null,
    body: null,
    state: 'accepted'
  },
  {
    // The one with a body, so expanded-card block order (meta before body) can be measured.
    summary: 'Burst allowance applies to every client, not the quiet client the comment promises',
    layer: 'correctness',
    severity: 'minor',
    diff_path: 'widget/src/rateLimiter.js',
    diff_line: 60,
    head_sha: FRESH_HEAD,
    comment_url: null,
    pushed_sha: null,
    body: `The in-diff comment justifies the burst as being for a client that has spent most of its window without exhausting the limit, echoed in the option jsdoc — but the code never checks *when* the limit was hit.

**Failure scenario**: a flood client exhausts \`limit\` (100) in the first second; from the halfway mark it receives 20 further allowed requests. The effective per-window cap for abusive clients is \`limit + burst\` (120), not \`limit\`.

See [widget/src/rateLimiter.js:57] and [widget/src/rateLimiter.js:22].`,
    state: 'pending'
  },
  {
    // Unflavored: no severity, no layer — must render no rail.
    summary: 'Plain finding with no severity or layer',
    layer: null,
    severity: null,
    diff_path: null,
    diff_line: null,
    head_sha: null,
    comment_url: null,
    pushed_sha: null,
    body: null,
    state: 'pending'
  }
]

const ins = db.prepare(
  `INSERT INTO findings
     (case_id, session_id, turn_id, summary, review_state, created_at,
      layer, severity, diff_path, diff_line, suggested_change, comment_url, pushed_sha,
      comment_body, head_sha)
   VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)

const seeded = findings.map((f) => {
  const r = ins.run(
    caseId,
    sessionId,
    f.summary,
    f.state,
    now,
    f.layer,
    f.severity,
    f.diff_path,
    f.diff_line,
    f.diff_path ? 'Flip the guard.' : null,
    f.comment_url,
    f.pushed_sha,
    f.diff_path ? 'Author-facing prose.' : null,
    f.head_sha
  )
  return { id: Number(r.lastInsertRowid), body: f.body, summary: f.summary }
})

// findings.md — bodies are joined back by the `<!-- finding:{id} -->` marker.
const caseDir = path.join(HOME, 'cases', SLUG)
fs.mkdirSync(caseDir, { recursive: true })
let md = `# Findings — ${SLUG}\n\n`
for (const f of seeded) {
  if (!f.body) continue
  md += `<!-- finding:${f.id} -->\n## ${f.summary}\n_meta_\n\n${f.body}\n\n`
}
fs.writeFileSync(path.join(caseDir, 'findings.md'), md, 'utf8')

console.log(
  JSON.stringify(
    {
      slug: SLUG,
      caseId,
      sessionId,
      worktreeDir,
      freshHead: FRESH_HEAD,
      staleHead: STALE_HEAD,
      findingIds: seeded.map((f) => f.id)
    },
    null,
    2
  )
)
db.close()
