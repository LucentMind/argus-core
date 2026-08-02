/**
 * Seed a home built for product screenshots.
 *
 * Sibling of `seed-test-home.mjs`, with a different job. That script maximises SHAPE coverage —
 * every rollup state, every trust tier, every finding badge — with the minimum content needed to
 * produce each shape. This one maximises CONTENT: one case investigated and reviewed in full,
 * knowledge that reads like a team wrote it, and enough filler to make the dashboard look like a
 * workspace someone actually uses.
 *
 * What it is built to show, in order:
 *   1. The knowledge flywheel. HMT-9-quota-drift produced a memory and a team reference; the
 *      flagship investigation READS both, which both shortens it and puts a non-zero usage count
 *      on those Library rows. The flagship then distils its own proposals, waiting for review.
 *   2. Evidence-grounded triage. Every `[path:line]` in every transcript and finding body is
 *      computed from the generated evidence or verified against the real checkout, and verify()
 *      re-checks all of them against the files on disk.
 *
 * Usage:
 *   ARGUS_HOME=<dir> npm run dev                          # boot once so migrations run, then quit
 *   ARGUS_HOME=<dir> node --experimental-sqlite app/scripts/seed-demo-home.mjs
 *   ARGUS_HOME=<dir> npm run dev                          # boot again; Rescan the flagship (see below)
 *
 * Defaults to C:\Users\Power\argus-demo when ARGUS_HOME is unset, so it cannot land on the test
 * home by accident.
 *
 * Requires git and gh on PATH, gh authenticated for JiaweiHan88/HiveMindTest.
 *
 * Evidence rows are NOT written: the trees land on disk and the app's own scanEvidence ingests
 * them when you click Rescan. Same rule as the test seed, same reason — a fixture that
 * reimplements indexer.ts's chunking drifts and then lies about how evidence search behaves.
 *
 * Only the flagship and the prior case carry evidence trees at all. That is deliberate: an
 * ingested evidence row is stamped with the ingestion time, which is newer than every seeded
 * signal, so Rescanning a case REWRITES its derived phase. Giving the filler cases no tree is
 * what keeps the dashboard's phase spread intact after you Rescan.
 *
 * Idempotent: per-case destructive, globally additive.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCtx } from './demo/ctx.mjs'
import { seedRepos } from './seed/repo.mjs'
import { seedCases, pinCasePhase, CASE_CONFIG } from './demo/cases.mjs'
import { buildAppLog, seedFiles } from './demo/evidence.mjs'
import {
  buildFlagshipFindings,
  buildPriorFindings,
  buildThinFindings,
  seedFindings
} from './demo/findings.mjs'
import { seedPrs } from './demo/prs.mjs'
import { seedKnowledge } from './demo/knowledge.mjs'
import { seedDistill } from './demo/distill.mjs'
import { makeCitationRe } from './demo/citations.mjs'

const CONTENT_DIRS = ['references', 'skills-user', 'skills-hivemind', 'memory', 'proposals']
const MARKER_FILE = '.argus-seed-home'
const DEFAULT_HOME = path.join(os.homedir(), 'argus-demo')

/**
 * Refuse to run destructively against a home this seed does not own.
 *
 * This has to be blunt and has to run first, because the argus.db preflight below is exactly
 * backwards as a safety filter: it rejects a fresh empty directory (no argus.db yet) and accepts
 * a real, populated, already-booted home. Left to the preflight alone, the homes this script
 * would agree to run against are precisely the homes with something to lose.
 */
function guardHome(home) {
  const normalize = (p) => {
    const resolved = path.resolve(p)
    let real = resolved
    try {
      real = fs.realpathSync.native(resolved)
    } catch {
      // Not on disk yet — the resolved path is the best comparison basis available.
    }
    return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real
  }
  const defaultArgusHome = path.join(os.homedir(), 'Argus')
  if (normalize(home) === normalize(defaultArgusHome)) {
    console.error(
      `refusing to seed the default Argus home (${defaultArgusHome}).\n` +
        'This seed deletes proposals/, skills-user/, skills-hivemind/, references/ and memory/,\n' +
        'and overwrites config/*.json wholesale. It will not run against the default home under\n' +
        'any flag, including --force. Point ARGUS_HOME at a scratch directory instead.'
    )
    process.exit(1)
  }

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
  if (populated.length === 0) return

  if (!process.argv.includes('--force')) {
    console.error(
      `${home} has no ${MARKER_FILE} marker and holds content this seed did not author:\n` +
        populated.map((d) => `  - ${d}/`).join('\n') +
        '\nRunning this seed would delete every one of those directories. Re-run with --force if\n' +
        'you are sure this home is disposable:\n' +
        `  ARGUS_HOME=${home} node --experimental-sqlite app/scripts/seed-demo-home.mjs --force\n\n` +
        'This is also the state left by a previous run that failed partway through verify():\n' +
        'content is written before the marker, which is only written after verification passes.\n' +
        'If that is what happened, --force is the correct response.'
    )
    process.exit(1)
  }
}

const HOME = process.env.ARGUS_HOME || DEFAULT_HOME
if (!process.env.ARGUS_HOME) console.log(`ARGUS_HOME unset — defaulting to ${HOME}`)

guardHome(HOME)

const dbFile = path.join(HOME, 'argus.db')
if (!fs.existsSync(dbFile)) {
  console.error(
    `no argus.db at ${dbFile}\nboot the app once first so migrations run:\n  ARGUS_HOME=${HOME} npm run dev`
  )
  process.exit(1)
}

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA foreign_keys = ON')

// A never-opened database has none of the columns db.ts adds by migration. Check every column
// this seed writes that arrived via ALTER TABLE — a database migrated only partway is exactly
// the "missing column midway through" case this preflight exists to prevent.
const REQUIRED_MIGRATED_COLUMNS = {
  cases: [
    'workspaces',
    'active_mode',
    'jira_status',
    'jira_priority',
    'jira_comment_count',
    'jira_attachment_ids',
    'phase_pin',
    'phase_pinned_at'
  ],
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
// Presence on PATH says nothing about whether gh can reach GitHub, and an unauthenticated gh
// fails inside seedPrs — which runs after every destructive delete. `gh auth status` is
// read-only, so it is safe to run this early.
try {
  execFileSync('gh', ['auth', 'status'], { encoding: 'utf8' })
} catch {
  console.error('gh is not authenticated — run `gh auth login` first')
  process.exit(1)
}

const ctx = createCtx({ argusHome: HOME, db })
const { text: appLog, anchors } = buildAppLog()

const repos = seedRepos({ ...ctx, SLUGS: ctx.REPO_SLUGS })
const { caseIds, sessionIds } = seedCases(ctx, { repos, anchors })

const findingIds = {}
const slugsWithBodies = new Set()
for (const slug of ctx.SLUGS) {
  if (CASE_CONFIG[slug].findings === false) {
    findingIds[slug] = []
    continue
  }
  const descriptors =
    slug === 'HMT-1-burst-token'
      ? buildFlagshipFindings({
          freshHead: repos.worktrees[slug].head,
          staleHead: repos.staleHead,
          anchors
        })
      : slug === 'HMT-9-quota-drift'
        ? buildPriorFindings()
        : buildThinFindings(slug)
  if (descriptors.some((d) => d.body)) slugsWithBodies.add(slug)
  findingIds[slug] = seedFindings(ctx, {
    caseId: caseIds[slug],
    sessionIds: sessionIds[slug],
    descriptors,
    slug,
    at: ctx.at,
    hours: CASE_CONFIG[slug].findingHours
  })
}

const prs = seedPrs(ctx, { caseIds, repoDir: repos.hmtDir })
const files = seedFiles(ctx, { appLog })
const knowledge = seedKnowledge(ctx, { repos })
const distill = seedDistill(ctx)

// Last, and after seedPrs: a pin is not sticky, it competes on its own timestamp against every
// other signal, so it must be the newest thing on its case to take the badge.
pinCasePhase(ctx, { slug: 'HMT-3-cancelled', pin: 'rca-drafted', hoursAgo: ctx.T.RCA_PIN })

verify()

fs.writeFileSync(
  path.join(HOME, MARKER_FILE),
  `seeded_at: ${ctx.nowIso()}\nSeeded by seed-demo-home.mjs. Safe to overwrite.\n`,
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
Ready. Boot against this home:

  ARGUS_HOME=${HOME} npm run dev

One manual step, on the FLAGSHIP CASE ONLY (HMT-1-burst-token):
  switch it to 'investigation' and click Rescan, then switch to 'review' and click Rescan again.
Evidence rows do not exist until you do — by design, so the fixture never reimplements the
real indexer. Do it in that order: the last mode you scan is the one whose phase badge wins,
and 'reviewing' is the intended badge for that case.

HMT-9-quota-drift also carries a tree and may be Rescanned if you want its evidence searchable.
That one is safe in any order: it is 'closed', and a closed status short-circuits derivePhase
entirely, so nothing ingested into it can move its badge.

Do NOT Rescan any other case. They have no evidence trees precisely so their phase badges
(open / analyzing / pr-created / rca-drafted / closed) survive — an ingested evidence row is
stamped at ingestion time and would outrank every seeded signal.

Two things that cannot come from a seed:
  - the approval/permission card renders from live state that is never replayed from disk;
    capture it from a running session.
  - PR and CI chips reflect real GitHub state on the day, so re-check them before shooting.
`)
db.close()

/** Assert the invariants that actually bite. Any failure exits non-zero. */
function verify() {
  const fail = (msg) => {
    console.error(`demo seed verification failed: ${msg}`)
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
    if (!caseIds[slug]) fail(`${slug}: no case id was created`)

    const cfg = CASE_CONFIG[slug]
    if (
      cfg.findings !== false &&
      (!Array.isArray(findingIds[slug]) || findingIds[slug].length === 0)
    ) {
      fail(`${slug}: seedFindings created no finding ids`)
    }

    // Exactly one binding per repo-backed case, and none at all on the filler cases — a
    // stray binding there would both cost a live refresh and rewrite the case's phase.
    const bindingCount = db
      .prepare('SELECT COUNT(*) c FROM pr_bindings WHERE case_id = ?')
      .get(caseIds[slug]).c
    const expected = ctx.REPO_SLUGS.includes(slug) ? 1 : 0
    if (bindingCount !== expected) {
      fail(`${slug}: expected ${expected} pull-request binding(s), found ${bindingCount}`)
    }

    const dir = ctx.caseDir(slug)
    const md = path.join(dir, 'findings.md')
    if (cfg.findings !== false) {
      if (!fs.existsSync(md)) fail(`${slug}: findings.md was not written`)
      let markerCount = 0
      for (const m of fs.readFileSync(md, 'utf8').matchAll(/<!-- finding:(\d+) -->/g)) {
        markerCount++
        if (!db.prepare('SELECT id FROM findings WHERE id = ?').get(Number(m[1]))) {
          fail(`${slug}/findings.md references finding ${m[1]}, which does not exist`)
        }
      }
      if (slugsWithBodies.has(slug) && markerCount === 0) {
        fail(`${slug}: findings.md resolves no markers, but this case seeded a finding body`)
      }
    }

    // Only the two content cases carry trees; the rest must stay empty so a Rescan cannot
    // rewrite their phase badges (see the header comment).
    const evList = walk(path.join(dir, 'evidence'))
    const artifactsList = walk(path.join(dir, 'artifacts'))
    if (cfg.content) {
      if (evList.length === 0) fail(`${slug}: evidence/ is empty but this case carries content`)
      if (artifactsList.length === 0)
        fail(`${slug}: artifacts/ is empty but this case carries content`)
    } else if (evList.length || artifactsList.length) {
      fail(
        `${slug}: has ${evList.length + artifactsList.length} evidence/artifact file(s) but is a ` +
          `filler case — ingesting them would rewrite its phase badge`
      )
    }
    const ev = new Set(evList)
    const overlap = artifactsList.filter((p) => ev.has(p))
    if (overlap.length) fail(`${slug}: ${overlap.length} path(s) in both evidence/ and artifacts/`)

    const n = db.prepare('SELECT COUNT(*) c FROM evidence WHERE case_id = ?').get(caseIds[slug]).c
    if (n !== 0) fail(`${slug}: ${n} evidence rows exist — this seed must write none`)

    // Every transcript line parses and carries a known event type.
    const KNOWN = new Set([
      'session.started',
      'session.exited',
      'session.error',
      'turn.started',
      'turn.completed',
      'content.delta',
      'assistant.message',
      'tool.call.started',
      'tool.call.completed',
      'request.opened',
      'request.resolved',
      'case.finding.added',
      'case.finding.updated',
      'case.evidence.ingested',
      'session.mcp.skipped',
      'dialog.opened',
      'dialog.resolved'
    ])
    for (const f of walk(path.join(dir, 'sessions'))) {
      const raw = fs.readFileSync(path.join(dir, 'sessions', f), 'utf8')
      raw.split('\n').forEach((line, i) => {
        if (!line.trim()) return
        let e
        try {
          e = JSON.parse(line)
        } catch {
          fail(`${slug}/sessions/${f}:${i + 1} is not valid JSON — the pane would drop it silently`)
        }
        if (!KNOWN.has(e.type))
          fail(`${slug}/sessions/${f}:${i + 1} has unknown event type ${e.type}`)
      })
    }
  }

  checkCitations(fail, walk)
  checkPhases(fail)

  // Proposals: every file parses and declares a valid type, and the on-disk counts match what
  // seedKnowledge reported. Comparing against the module's own return value (rather than merely
  // requiring > 0) is what catches a no-opped module instead of a previous run's leftovers.
  const TYPES = new Set([
    'skill-new',
    'skill-edit',
    'reference-edit',
    'recipe',
    'memory-append',
    'case-summary'
  ])
  const pDir = path.join(HOME, 'proposals')
  const counts = { '': 0, archive: 0 }
  for (const sub of ['', 'archive']) {
    const d = path.join(pDir, sub)
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.md'))) {
      counts[sub]++
      const type = /^type:\s*(.+)$/m.exec(fs.readFileSync(path.join(d, f), 'utf8'))?.[1]?.trim()
      if (!TYPES.has(type)) {
        fail(`proposal ${sub ? `${sub}/${f}` : f} has invalid type ${JSON.stringify(type)}`)
      }
    }
  }
  // A pending reference-edit must carry the FULL intended file, not just its new section:
  // acceptProposal's reference branch replaces the file wholesale (proposals.ts), and
  // ProposalsPage diffs the proposal body against the raw on-disk file. A partial body
  // therefore both renders as "delete the whole reference" and, on accept, does exactly that.
  // Asserting the current file is a prefix of the body is the invariant that rules it out.
  for (const f of fs.existsSync(pDir)
    ? fs.readdirSync(pDir).filter((x) => x.endsWith('.md'))
    : []) {
    const raw = fs.readFileSync(path.join(pDir, f), 'utf8')
    const type = /^type:\s*(.+)$/m.exec(raw)?.[1]?.trim()
    if (type !== 'reference-edit') continue
    const target = /^target:\s*(.+)$/m.exec(raw)?.[1]?.trim()
    const onDisk = path.join(HOME, 'references', target)
    if (!fs.existsSync(onDisk)) continue // proposing a brand-new reference is legitimate
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    if (!body.startsWith(fs.readFileSync(onDisk, 'utf8'))) {
      fail(
        `proposal ${f} is a reference-edit whose body does not start with the current ` +
          `references/${target} — accepting it would delete the rest of that reference, and the ` +
          `Proposals screen renders it as a full-file replacement`
      )
    }
  }

  if (counts[''] !== knowledge.proposals) {
    fail(
      `pending proposals on disk (${counts['']}) != seedKnowledge reported (${knowledge.proposals})`
    )
  }
  if (counts.archive !== knowledge.archived) {
    fail(
      `archived proposals on disk (${counts.archive}) != seedKnowledge reported (${knowledge.archived})`
    )
  }

  const slugPlaceholders = ctx.SLUGS.map(() => '?').join(',')
  const jobCount = db
    .prepare(`SELECT COUNT(*) c FROM distill_jobs WHERE case_slug IN (${slugPlaceholders})`)
    .get(...ctx.SLUGS).c
  if (jobCount !== distill.jobs)
    fail(`distill_jobs rows (${jobCount}) != reported (${distill.jobs})`)
  const summaryCount = db
    .prepare(`SELECT COUNT(*) c FROM case_summaries WHERE case_slug IN (${slugPlaceholders})`)
    .get(...ctx.SLUGS).c
  if (summaryCount !== distill.summaries) {
    fail(`case_summaries rows (${summaryCount}) != reported (${distill.summaries})`)
  }
  const bad = db
    .prepare("SELECT id FROM distill_jobs WHERE state = 'failed' AND raw_output IS NULL")
    .all()
  if (bad.length) fail(`${bad.length} failed distill job(s) with null raw_output`)

  // The flywheel has to be wired, not merely present: the investigation must have READ the
  // knowledge the prior case produced, or the Library usage counts are zero and the whole
  // story is invisible.
  for (const [detail, what] of [
    ['burst-window-math', 'the burst-window-math memory'],
    ['ref:rate-limit-patterns.md', 'the rate-limit-patterns reference']
  ]) {
    const used = db
      .prepare('SELECT COUNT(*) c FROM tool_calls WHERE detail = ? AND case_id = ?')
      .get(detail, caseIds['HMT-1-burst-token']).c
    if (used === 0)
      fail(`the flagship investigation never reads ${what} — the flywheel is not wired`)
  }
  const skillUse = db
    .prepare("SELECT COUNT(*) c FROM tool_calls WHERE tool = 'Skill' AND decision = 'observed'")
    .get().c
  if (skillUse === 0) fail('no Skill invocations recorded — Library usage stats will be empty')
}

/**
 * Check each case derives the phase badge its config claims.
 *
 * The dashboard screenshot IS the phase spread, and phase is derived from a race between
 * timestamps in four different modules — so moving any one of them silently re-badges a case,
 * and nothing else would notice. This already caught HMT-4-nochecks reading 'reviewing' instead
 * of 'pr-created' because the global review-finding timestamp outranked its binding.
 *
 * The signal queries below are transcribed from readCaseSignals() in caseService.ts and the
 * candidate ordering from derivePhase() in shared/casePhase.ts. Evidence signals are omitted
 * deliberately: this seed writes no evidence rows (Rescan does), so at seed time they are always
 * null — which is exactly the state being asserted.
 */
function checkPhases(fail) {
  const rows = db.prepare('SELECT id, slug, status, phase_pin, phase_pinned_at FROM cases').all()
  const maxBy = (sql) => {
    const m = new Map()
    for (const r of db.prepare(sql).all()) m.set(`${r.cid}:${r.mode ?? ''}`, r.lastAt)
    return m
  }
  const turns = maxBy(
    `SELECT t.case_id cid, COALESCE(s.mode,'investigation') mode, MAX(t.created_at) lastAt
       FROM turns t LEFT JOIN sessions s ON s.id = t.session_id
      GROUP BY t.case_id, COALESCE(s.mode,'investigation')`
  )
  const finds = maxBy(
    `SELECT f.case_id cid, COALESCE(s.mode,'investigation') mode, MAX(f.created_at) lastAt
       FROM findings f LEFT JOIN sessions s ON s.id = f.session_id
      GROUP BY f.case_id, COALESCE(s.mode,'investigation')`
  )
  const bindings = maxBy(
    `SELECT case_id cid, NULL mode, MAX(detected_at) lastAt FROM pr_bindings GROUP BY case_id`
  )

  for (const r of rows) {
    const want = CASE_CONFIG[r.slug]?.phase
    if (!want) continue
    let got
    if (r.status === 'closed') {
      got = 'closed'
    } else {
      // Order matters: it is the tie-break, since derivePhase compares with a strict `>`.
      const candidates = [
        [r.phase_pin ? r.phase_pinned_at : null, r.phase_pin ?? 'open'],
        [turns.get(`${r.id}:review`), 'reviewing'],
        [finds.get(`${r.id}:review`), 'reviewing'],
        [bindings.get(`${r.id}:`), 'pr-created'],
        [turns.get(`${r.id}:investigation`), 'analyzing'],
        [finds.get(`${r.id}:investigation`), 'analyzing']
      ]
      let best = null
      for (const [at, phase] of candidates) {
        if (at == null) continue
        if (best === null || at > best.at) best = { at, phase }
      }
      got = best?.phase ?? 'open'
    }
    if (got !== want) {
      fail(
        `${r.slug}: derives phase '${got}' but its config declares '${want}' — a timestamp moved ` +
          `and the dashboard badge changed with it`
      )
    }
  }
  const spread = new Set(Object.values(CASE_CONFIG).map((c) => c.phase))
  console.log(
    `phase check: ${rows.length} cases, ${spread.size} distinct badges (${[...spread].join(', ')})`
  )
}

/**
 * Re-read every file cited anywhere in the seeded content and check the cited line exists.
 *
 * This is the check the demo is actually about. A citation that points past the end of its file
 * — or at a file that is not there — is the product visibly lying the moment someone clicks it,
 * and nothing else in the pipeline would notice: the line numbers are interpolated into prose,
 * so a generator change breaks them silently and typechecking cannot see it.
 */
function checkCitations(fail, walk) {
  const lineCache = new Map()
  const linesOf = (abs) => {
    if (!lineCache.has(abs)) {
      lineCache.set(
        abs,
        fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n').length : null
      )
    }
    return lineCache.get(abs)
  }

  // A citation resolves against the case dir (evidence/…, artifacts/…) or, when it is prefixed
  // with a linked repo's name, against that repo's worktree.
  const resolve = (slug, relPath) => {
    const slash = relPath.indexOf('/')
    const head = slash === -1 ? '' : relPath.slice(0, slash)
    if (head === 'hmt') {
      const wt = repos.worktrees[slug] ?? repos.worktrees['HMT-1-burst-token']
      return path.join(wt.dir, relPath.slice(slash + 1))
    }
    return path.join(ctx.caseDir(slug), relPath)
  }

  let checked = 0
  const scan = (slug, label, text) => {
    for (const m of text.matchAll(makeCitationRe())) {
      const [, relPath, linespec] = m
      const line = Number(linespec.split(',')[0].split('-')[0])
      const abs = resolve(slug, relPath)
      const total = linesOf(abs)
      if (total === null) fail(`${label} cites ${relPath}, which does not exist at ${abs}`)
      if (line > total) {
        fail(`${label} cites ${relPath}:${line}, but that file has only ${total} lines`)
      }
      checked++
    }
  }

  for (const slug of ctx.SLUGS) {
    const dir = ctx.caseDir(slug)
    const md = path.join(dir, 'findings.md')
    if (fs.existsSync(md)) scan(slug, `${slug}/findings.md`, fs.readFileSync(md, 'utf8'))
    for (const f of walk(path.join(dir, 'sessions'))) {
      const raw = fs.readFileSync(path.join(dir, 'sessions', f), 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        const e = JSON.parse(line)
        const text =
          e.payload?.text ?? e.payload?.userText ?? e.payload?.outputPreview ?? e.payload?.markdown
        if (typeof text === 'string') scan(slug, `${slug}/sessions/${f}`, text)
      }
    }
  }
  if (checked === 0) fail('no citations found anywhere — the evidence-grounded story is missing')
  console.log(`citation check: ${checked} citations resolved against real files`)
}
