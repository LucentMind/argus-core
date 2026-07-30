#!/usr/bin/env node
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
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
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

const HOME = process.env.ARGUS_HOME
if (!HOME) {
  console.error('set ARGUS_HOME to the home to seed')
  process.exit(1)
}

const dbFile = path.join(HOME, 'argus.db')
if (!fs.existsSync(dbFile)) {
  console.error(
    `no argus.db at ${dbFile}\nboot the app once first:\n  ARGUS_HOME=${HOME} npm run dev`
  )
  process.exit(1)
}

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA foreign_keys = ON')

// A never-opened database has none of the columns db.ts adds by migration. Check
// the newest one rather than failing on a missing column halfway through.
const findingCols = db
  .prepare('PRAGMA table_info(findings)')
  .all()
  .map((c) => c.name)
for (const required of ['severity', 'layer', 'head_sha', 'comment_body']) {
  if (!findingCols.includes(required)) {
    console.error(
      `argus.db is not migrated (findings.${required} missing)\nboot the app once first:\n  ARGUS_HOME=${HOME} npm run dev`
    )
    process.exit(1)
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

const ctx = createCtx({ argusHome: HOME, db })

const repos = seedRepos(ctx)
const { caseIds, sessionIds } = seedCases(ctx, { repos })

const findingIds = {}
for (const slug of ctx.SLUGS) {
  const descriptors =
    slug === 'HMT-1-burst-token'
      ? buildFlagshipFindings({
          freshHead: repos.worktrees[slug].head,
          staleHead: repos.staleHead
        })
      : buildThinFindings(slug)
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
`)
db.close()

/** Assert the invariants that actually bite. Any failure exits non-zero. */
function verify() {
  const fail = (msg) => {
    console.error(`seed verification failed: ${msg}`)
    process.exit(1)
  }

  // One binding per case — pr_bindings_one_per_case makes a second one fatal at open().
  const dupes = db
    .prepare('SELECT case_id, COUNT(*) n FROM pr_bindings GROUP BY case_id HAVING n > 1')
    .all()
  if (dupes.length) fail(`${dupes.length} case(s) with more than one pull-request binding`)

  for (const slug of ctx.SLUGS) {
    // Every findings.md marker resolves to a live row.
    const md = path.join(ctx.caseDir(slug), 'findings.md')
    const raw = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : ''
    for (const m of raw.matchAll(/<!-- finding:(\d+) -->/g)) {
      const row = db.prepare('SELECT id FROM findings WHERE id = ?').get(Number(m[1]))
      if (!row) fail(`${slug}/findings.md references finding ${m[1]}, which does not exist`)
    }

    // The two trees are disjoint.
    const dir = ctx.caseDir(slug)
    const walk = (root) =>
      fs.existsSync(root)
        ? fs
            .readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => path.relative(root, path.join(e.parentPath ?? e.path, e.name)))
        : []
    const ev = new Set(walk(path.join(dir, 'evidence')))
    const overlap = walk(path.join(dir, 'artifacts')).filter((p) => ev.has(p))
    if (overlap.length) fail(`${slug}: ${overlap.length} path(s) in both evidence/ and artifacts/`)

    // No evidence rows were written.
    const n = db.prepare('SELECT COUNT(*) c FROM evidence WHERE case_id = ?').get(caseIds[slug]).c
    if (n !== 0) fail(`${slug}: ${n} evidence rows exist — this seed must write none`)

    // The worktree exists and has a real HEAD.
    const wt = repos.worktrees[slug]
    try {
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt.dir, encoding: 'utf8' })
    } catch {
      fail(`${slug}: worktree at ${wt.dir} has no readable HEAD`)
    }
  }

  // Every proposal file parses and declares a valid type.
  const TYPES = new Set([
    'skill-new',
    'skill-edit',
    'reference-edit',
    'recipe',
    'memory-append',
    'case-summary'
  ])
  const pDir = path.join(HOME, 'proposals')
  for (const sub of ['', 'archive']) {
    const d = path.join(pDir, sub)
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.md'))) {
      const raw = fs.readFileSync(path.join(d, f), 'utf8')
      const type = /^type:\s*(.+)$/m.exec(raw)?.[1]?.trim()
      if (!TYPES.has(type)) fail(`proposal ${sub}/${f} has invalid type ${JSON.stringify(type)}`)
    }
  }

  // A failed distill job with no raw_output is a corpus defect evalExport reports.
  const bad = db
    .prepare("SELECT id FROM distill_jobs WHERE state = 'failed' AND raw_output IS NULL")
    .all()
  if (bad.length) fail(`${bad.length} failed distill job(s) with null raw_output`)
}
