/**
 * Seed one ARGUS_HOME covering every surface of the app at once — cases, pull
 * requests, CI outcomes, findings, evidence, review artifacts, proposals, skill
 * and reference tiers, distill rows and configuration.
 *
 * Usage:
 *   ARGUS_HOME=<dir> npm run dev                              # boot once so migrations run, then quit
 *   ARGUS_HOME=<dir> node --experimental-sqlite app/scripts/seed-test-home.mjs
 *   ARGUS_HOME=<dir> npm run dev                              # boot again, click Rescan per case
 *
 * Requires git and gh on PATH, with gh authenticated for JiaweiHan88/HiveMindTest.
 *
 * Evidence rows are NOT written: the trees land on disk and the app's own
 * scanEvidence ingests them when you click Rescan. That is deliberate — a
 * fixture that reimplements indexer.ts's chunking would drift and then lie
 * about how evidence search behaves.
 *
 * Idempotent: per-case destructive, globally additive.
 *
 * Safety: this script refuses to run against the app's default home
 * (~/Argus) under any flag. Against any other home, it refuses to run
 * destructively unless the home already carries a `.argus-seed-home` marker
 * (written by a prior successful run of this script) or is otherwise empty of
 * references/, skills-user/, skills-hivemind/, memory/ and proposals/ content
 * — pass --force to proceed anyway once you are sure the home is disposable.
 * See guardHome() below.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCtx } from './seed/ctx.mjs'
import { seedRepos } from './seed/repo.mjs'
import { seedCases } from './seed/cases.mjs'
import { buildFlagshipFindings, buildThinFindings, seedFindings } from './seed/findings.mjs'
import { seedPrs } from './seed/prs.mjs'
import { seedFiles } from './seed/files.mjs'
import { seedKnowledge } from './seed/knowledge.mjs'
import { seedDistill } from './seed/distill.mjs'

// Deliberately excludes config/: a freshly booted home always has a fully-configured
// config/ (provider instances, hivemind repo, tool-risk overrides) while these five are
// still empty, so guarding config/ here would make every legitimate first seed of a
// scratch home demand --force — see the backup comment in seed/knowledge.mjs for how the
// resulting config/ data loss is made recoverable instead.
const CONTENT_DIRS = ['references', 'skills-user', 'skills-hivemind', 'memory', 'proposals']
const MARKER_FILE = '.argus-seed-home'

/**
 * Refuse to run destructively against a home this seed does not own. Called before any
 * other module runs and before argus.db is even opened.
 *
 * Why this guard has to live here and be this blunt: the migration preflight further down
 * requires argus.db to already exist and be migrated. That requirement is right for its own
 * purpose (fail fast on a schema the seed can't write) but it is EXACTLY BACKWARDS as a
 * safety filter — it rejects a fresh, empty, harmless directory (no argus.db yet) and
 * accepts a real, already-booted, populated home (which has one). Left to the preflight
 * alone, the homes this script is willing to run against are precisely the homes that have
 * something to lose. This function is what stands between a copy-pasted or mistyped
 * ARGUS_HOME and silently deleting someone's real proposals/skills/references/memory.
 */
function guardHome(home) {
  // Resolve through the real filesystem entry (symlinks, junctions) before comparing, not
  // just the textual path, so a junction pointing at the default home from a different
  // path is still caught. A scratch home that does not exist yet (the common case — this
  // runs before the seed has created anything) has no realpath to resolve, so fall back to
  // the plain resolved path rather than letting realpathSync throw past this guard.
  const normalize = (p) => {
    const resolved = path.resolve(p)
    let real = resolved
    try {
      real = fs.realpathSync.native(resolved)
    } catch {
      // Target doesn't exist on disk yet — resolved (unresolved-symlink) path is the best
      // available comparison basis.
    }
    // Case-insensitive filesystems: win32 always, and macOS by default (darwin's HFS+/APFS
    // are case-insensitive out of the box, though not guaranteed to be).
    return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real
  }
  const defaultHome = path.join(os.homedir(), 'Argus')
  if (normalize(home) === normalize(defaultHome)) {
    console.error(
      `refusing to seed the default Argus home (${defaultHome}).\n` +
        'This seed deletes proposals/ (incl. archive/), skills-user/, skills-hivemind/,\n' +
        'references/ and memory/ (incl. .audit.jsonl and archive/), and overwrites\n' +
        'config/hivemind-state.json, config/settings.json, config/agent-access.json and\n' +
        'config/tool-risk.json wholesale. It will not run against the default home under\n' +
        'any flag, including --force. Point ARGUS_HOME at a scratch directory instead.'
    )
    process.exit(1)
  }

  // A marker means a previous successful run of THIS script created (or re-seeded) this
  // home, so re-running is expected and should stay friction-free.
  if (fs.existsSync(path.join(home, MARKER_FILE))) return

  const dirHasContent = (dir) => {
    if (!fs.existsSync(dir)) return false
    const stack = [dir]
    while (stack.length) {
      const d = stack.pop()
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isFile()) return true
        if (e.isDirectory()) stack.push(path.join(d, e.name))
      }
    }
    return false
  }
  const populated = CONTENT_DIRS.filter((d) => dirHasContent(path.join(home, d)))
  if (populated.length === 0) return // nothing here the seed didn't author; safe to proceed

  if (!process.argv.includes('--force')) {
    console.error(
      `${home} has no ${MARKER_FILE} marker and holds content this seed did not author:\n` +
        populated.map((d) => `  - ${d}/`).join('\n') +
        '\nRunning this seed would delete every one of those directories. Re-run with\n' +
        '--force if you are sure this home is disposable:\n' +
        `  ARGUS_HOME=${home} node --experimental-sqlite app/scripts/seed-test-home.mjs --force\n\n` +
        'Note: this is also exactly the state left by a previous run of this seed that failed\n' +
        'partway through verify() — content is written before the marker, which is only\n' +
        'written after verification passes. If that is what happened, --force is the correct\n' +
        'response, not a sign of a foreign home.\n\n' +
        'Separately, config/hivemind-state.json, config/settings.json, config/agent-access.json\n' +
        'and config/tool-risk.json are not checked above (and never will be — see CONTENT_DIRS\n' +
        "comment) but ARE overwritten wholesale on every run. Each file's previous contents are\n" +
        'backed up first to config/.seed-backup/<name>.json (one generation, overwritten each run)\n' +
        'if you need to recover something after the fact.'
    )
    process.exit(1)
  }
}

const HOME = process.env.ARGUS_HOME
if (!HOME) {
  console.error('set ARGUS_HOME to the home to seed')
  process.exit(1)
}

// Refuse before any module runs, before the first destructive call — see guardHome()
// below for why the argus.db preflight further down makes this necessary rather than
// paranoid.
guardHome(HOME)

const dbFile = path.join(HOME, 'argus.db')
if (!fs.existsSync(dbFile)) {
  console.error(
    `no argus.db at ${dbFile}\nboot the app once first:\n  ARGUS_HOME=${HOME} npm run dev`
  )
  process.exit(1)
}

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA foreign_keys = ON')

// A never-opened database has none of the columns db.ts adds by migration. Check every
// column the seed actually writes to any table that was added by an ALTER TABLE migration
// (not a sample) — a database migrated only up to *some* of these is exactly the "missing
// column midway through" case this preflight exists to prevent, and the newest such ALTER
// is distill_jobs.prompt_hash (db.ts adds it after findings.comment_body/head_sha), not
// any of the findings columns alone.
const REQUIRED_MIGRATED_COLUMNS = {
  cases: ['workspaces', 'active_mode'],
  sessions: ['driver_kind', 'instance_id', 'model', 'title', 'mode'],
  turns: ['model'],
  tool_calls: ['detail'],
  findings: [
    'layer',
    'severity',
    'diff_path',
    'diff_line',
    'suggested_change',
    'comment_url',
    'pushed_sha',
    'comment_body',
    'head_sha'
  ],
  distill_jobs: ['prompt_hash']
}
for (const [table, cols] of Object.entries(REQUIRED_MIGRATED_COLUMNS)) {
  const have = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)
  for (const required of cols) {
    if (!have.includes(required)) {
      console.error(
        `argus.db is not migrated (${table}.${required} missing)\nboot the app once first:\n  ARGUS_HOME=${HOME} npm run dev`
      )
      process.exit(1)
    }
  }
}

for (const bin of ['git', 'gh']) {
  try {
    execFileSync(bin, ['--version'], { encoding: 'utf8' })
  } catch {
    console.error(`${bin} is not on PATH`)
    process.exit(1)
  }
}

// Presence on PATH says nothing about whether gh can actually talk to GitHub — an
// unauthenticated gh fails inside seedPrs, which runs after every destructive delete and
// write. `gh auth status` is read-only, so it is safe to run this early.
try {
  execFileSync('gh', ['auth', 'status'], { encoding: 'utf8' })
} catch {
  console.error('gh is not authenticated — run `gh auth login` first')
  process.exit(1)
}

const ctx = createCtx({ argusHome: HOME, db })

const repos = seedRepos(ctx)
const { caseIds, sessionIds } = seedCases(ctx, { repos })

const findingIds = {}
// Tracks which cases seeded at least one finding with a body — only those cases can be
// expected to resolve a `<!-- finding:N -->` marker in findings.md (see verify() below).
const slugsWithBodies = new Set()
for (const slug of ctx.SLUGS) {
  const descriptors =
    slug === 'HMT-1-burst-token'
      ? buildFlagshipFindings({
          freshHead: repos.worktrees[slug].head,
          staleHead: repos.staleHead
        })
      : buildThinFindings(slug)
  if (descriptors.some((d) => d.body)) slugsWithBodies.add(slug)
  findingIds[slug] = seedFindings(ctx, {
    caseId: caseIds[slug],
    sessionIds: sessionIds[slug],
    descriptors,
    slug
  })
}

const prs = seedPrs(ctx, { caseIds, repoDir: repos.hmtDir })
const files = await seedFiles(ctx)
const knowledge = seedKnowledge(ctx, { repos })
const distill = seedDistill(ctx)

verify()

// Only written once verification passes: a home carrying this marker is provably
// seed-owned, so guardHome() lets future re-seeds proceed without --force.
fs.writeFileSync(
  path.join(HOME, MARKER_FILE),
  `seeded_at: ${ctx.nowIso()}\nThis home is managed by seed-test-home.mjs and is safe to overwrite.\n`,
  'utf8'
)

console.log(
  JSON.stringify(
    { home: HOME, caseIds, sessionIds, findingIds, prs, files, knowledge, distill },
    null,
    2
  )
)
console.log(`
Next: boot the app against this home and click Rescan once per case.
Evidence rows do not exist until you do — by design.

  ARGUS_HOME=${HOME} npm run dev

Note: config/hivemind-state.json, config/settings.json, config/agent-access.json and
config/tool-risk.json were overwritten wholesale. Whatever was there before this run is
backed up at config/.seed-backup/<name>.json (one generation, overwritten each run).
`)
db.close()

/** Assert the invariants that actually bite. Any failure exits non-zero. */
function verify() {
  const fail = (msg) => {
    console.error(`seed verification failed: ${msg}`)
    process.exit(1)
  }

  const walk = (root) =>
    fs.existsSync(root)
      ? fs
          .readdirSync(root, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => path.relative(root, path.join(e.parentPath ?? e.path, e.name)))
      : []

  for (const slug of ctx.SLUGS) {
    // Positive: a case row actually exists for every seeded slug.
    if (!caseIds[slug]) fail(`${slug}: no case id was created`)

    // Positive: seedFindings actually created at least one finding row for every seeded
    // slug. Without this, a builder silently returning [] leaves "slugs with bodies" (and
    // therefore the marker-count check below) vacuously satisfied — zero ids in, zero
    // markers expected, check passes even though nothing was seeded.
    if (!Array.isArray(findingIds[slug]) || findingIds[slug].length === 0) {
      fail(`${slug}: seedFindings created no finding ids`)
    }

    // Positive: exactly one pull-request binding per seeded case — not "at most one"
    // (a case with zero bindings is a silently missing seed step, not a pass), and
    // scoped to the cases this run seeded rather than the whole table (an unrelated
    // pre-existing case with duplicate bindings must not fail a correct run).
    const bindingCount = db
      .prepare('SELECT COUNT(*) c FROM pr_bindings WHERE case_id = ?')
      .get(caseIds[slug]).c
    if (bindingCount !== 1) {
      fail(`${slug}: expected exactly one pull-request binding, found ${bindingCount}`)
    }

    // Positive: findings.md exists, and — for the cases that actually seeded a finding
    // with a body — resolves at least one marker. A missing file or a silently no-opped
    // seedFindings must not read as success just because zero markers is easy to satisfy.
    const md = path.join(ctx.caseDir(slug), 'findings.md')
    if (!fs.existsSync(md)) fail(`${slug}: findings.md was not written`)
    const raw = fs.readFileSync(md, 'utf8')
    let markerCount = 0
    for (const m of raw.matchAll(/<!-- finding:(\d+) -->/g)) {
      markerCount++
      const row = db.prepare('SELECT id FROM findings WHERE id = ?').get(Number(m[1]))
      if (!row) fail(`${slug}/findings.md references finding ${m[1]}, which does not exist`)
    }
    if (slugsWithBodies.has(slug) && markerCount === 0) {
      fail(`${slug}: findings.md resolves no markers, but this case seeded a finding body`)
    }

    // Positive: both trees exist and are non-empty.
    const dir = ctx.caseDir(slug)
    const evList = walk(path.join(dir, 'evidence'))
    const artifactsList = walk(path.join(dir, 'artifacts'))
    if (evList.length === 0) fail(`${slug}: evidence/ is empty`)
    if (artifactsList.length === 0) fail(`${slug}: artifacts/ is empty`)

    // Negative: the two trees are disjoint.
    const ev = new Set(evList)
    const overlap = artifactsList.filter((p) => ev.has(p))
    if (overlap.length) fail(`${slug}: ${overlap.length} path(s) in both evidence/ and artifacts/`)

    // Negative: no evidence rows were written.
    const n = db.prepare('SELECT COUNT(*) c FROM evidence WHERE case_id = ?').get(caseIds[slug]).c
    if (n !== 0) fail(`${slug}: ${n} evidence rows exist — this seed must write none`)

    // The worktree exists and has a real HEAD. Capture `wt` and guard it before the try:
    // if repos.worktrees[slug] were ever undefined, dereferencing wt.dir a second time
    // inside the catch (as the diagnostic used to) throws past the catch and replaces the
    // intended failure message with a raw stack trace.
    const wt = repos.worktrees[slug]
    if (!wt) fail(`${slug}: no worktree record from seedRepos`)
    try {
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt.dir, encoding: 'utf8' })
    } catch {
      fail(`${slug}: worktree at ${wt.dir} has no readable HEAD`)
    }
  }

  // Every proposal file parses and declares a valid type, and both the pending and
  // archived sets are non-empty — a silently no-opped seedKnowledge must not pass just
  // because an empty directory has no invalid types to find.
  const TYPES = new Set([
    'skill-new',
    'skill-edit',
    'reference-edit',
    'recipe',
    'memory-append',
    'case-summary'
  ])
  const pDir = path.join(HOME, 'proposals')
  const proposalCounts = { '': 0, archive: 0 }
  for (const sub of ['', 'archive']) {
    const d = path.join(pDir, sub)
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.md'))) {
      proposalCounts[sub]++
      const raw = fs.readFileSync(path.join(d, f), 'utf8')
      const type = /^type:\s*(.+)$/m.exec(raw)?.[1]?.trim()
      // sub is '' for the pending directory (proposals/ itself has no subdirectory), so
      // building the label as `${sub}/${f}` rendered as "proposal /2026-...md" — a leading
      // slash with no directory name. Only join a separator when sub is non-empty.
      const label = sub ? `${sub}/${f}` : f
      if (!TYPES.has(type)) fail(`proposal ${label} has invalid type ${JSON.stringify(type)}`)
    }
  }
  if (proposalCounts[''] === 0) fail('no pending proposals were written')
  if (proposalCounts.archive === 0) fail('no archived proposals were written')

  // Positive: at least one distill job and one case summary exist FOR THE CASES THIS RUN
  // SEEDED. An unscoped COUNT(*) would pass on rows left behind by a previous run even if
  // this run's seedDistill did nothing at all — scoping to the roster slugs means only
  // rows this run could plausibly have produced count as evidence it worked.
  const slugPlaceholders = ctx.SLUGS.map(() => '?').join(',')
  const jobCount = db
    .prepare(`SELECT COUNT(*) c FROM distill_jobs WHERE case_slug IN (${slugPlaceholders})`)
    .get(...ctx.SLUGS).c
  if (jobCount === 0) fail('no distill_jobs rows exist for the seeded cases')
  const summaryCount = db
    .prepare(`SELECT COUNT(*) c FROM case_summaries WHERE case_slug IN (${slugPlaceholders})`)
    .get(...ctx.SLUGS).c
  if (summaryCount === 0) fail('no case_summaries rows exist for the seeded cases')

  // A failed distill job with no raw_output is a corpus defect evalExport reports.
  const bad = db
    .prepare("SELECT id FROM distill_jobs WHERE state = 'failed' AND raw_output IS NULL")
    .all()
  if (bad.length) fail(`${bad.length} failed distill job(s) with null raw_output`)
}
