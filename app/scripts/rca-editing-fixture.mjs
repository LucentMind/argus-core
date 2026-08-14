#!/usr/bin/env node
/**
 * Fixture for `cdp-rca-editing.mjs` (RCA increment 3 — editing the report before it posts).
 *
 * Seeds a case with a `done` RCA job, so the gate can drive the panel without spending a real
 * model run. The model call is the ONE part of the flow this increment does not own: the draft
 * it produces is validated, stored as `raw_output`, and parsed back out by `statusFor`. Skipping
 * it changes nothing downstream — confirm, the artifact writes, the hand-edited comparison and
 * every warning still run for real.
 *
 * Two cases, because the gate needs two independent starting points:
 *   - `rca-edit-gate`   — the main flow: drop a section, confirm, hand-edit, warn, regenerate.
 *   - `rca-meta-gate`   — confirmed with NO jira key, so the gate can link one afterwards and
 *                         prove the hand-edited badge stays quiet (the caseMeta snapshot fix).
 *
 * `sections` is populated for every enabled narrative id in the default template: `runJob`
 * validates raw output against the job's template, so a draft without them is what a model that
 * ignored the brief returns, and would never have reached `done` in the real app.
 *
 * Usage:
 *   ARGUS_HOME=/path/to/home node scripts/rca-editing-fixture.mjs
 *
 * Requires an ARGUS_HOME whose argus.db has been through the app's startup migrations — boot the
 * app against it once first. `meta_snapshot` is a migration, not part of the base SCHEMA.
 *
 * Idempotent: re-running deletes these slugs (rows AND their case directories) and reinserts.
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const home = process.env.ARGUS_HOME
if (!home) {
  console.error('ARGUS_HOME is required')
  process.exit(1)
}
const dbPath = path.join(home, 'argus.db')
if (!fs.existsSync(dbPath)) {
  console.error(`no argus.db at ${dbPath} — boot the app against this home once first`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath)

// Fail loudly rather than seeding a home that predates the column the gate is here to test.
const cols = db
  .prepare(`PRAGMA table_info(rca_jobs)`)
  .all()
  .map((c) => c.name)
for (const required of ['template_snapshot', 'dropped_sections', 'meta_snapshot']) {
  if (!cols.includes(required)) {
    console.error(`argus.db has no rca_jobs.${required} — boot the app against this home first`)
    process.exit(1)
  }
}

/** Every enabled narrative id in DEFAULT_RCA_TEMPLATE, exec then tech. Kept as a literal rather
 *  than imported: this file is plain .mjs and the template lives in TypeScript. If the default
 *  template changes, the gate's confirm will fail validation loudly, which is the right failure. */
const NARRATIVE_IDS = [
  'exec-what-happened',
  'exec-impact',
  'exec-root-cause',
  'exec-what-we-did',
  'exec-next-steps',
  'tech-impact'
]

const draft = {
  rootCause: {
    findingId: null,
    statement: 'the cache key omitted the tenant id',
    evidence: [{ path: 'logs/app.log', line: 12, evidence: 'cache hit for wrong tenant' }]
  },
  contributing: [{ findingId: null, statement: 'no tenant-scoping test existed', evidence: [] }],
  symptoms: [{ findingId: null, statement: 'customers saw other tenants data' }],
  ruledOut: [],
  duplicates: [],
  impact: 'cross-tenant data leak in cached responses',
  timeline: [],
  remediation: { immediate: 'invalidate the cache', followUps: ['add tenant id to cache key'] },
  execSummary: {
    whatBroke: 'cached data leaked between tenants',
    impact: 'customers saw other tenants data',
    why: 'the cache key omitted the tenant id',
    nextSteps: 'add the tenant id to the cache key'
  },
  techNarrative: [],
  sections: Object.fromEntries(
    NARRATIVE_IDS.map((id) => [id, { body: `Body of ${id}.`, citations: [] }])
  )
}

const input = {
  caseMeta: {
    slug: 'placeholder',
    title: 'placeholder',
    jiraKey: null,
    resolution: null,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z'
  },
  findings: [],
  evidence: [],
  jiraTicketMarkdown: null,
  jiraCommentsMarkdown: null,
  transcripts: [],
  priorDraft: null
}

const CASES = [
  { slug: 'rca-edit-gate', title: 'Cross-tenant cache leak', jiraKey: 'GATE-1' },
  // No jira key on purpose — the gate links one AFTER confirming, which is the exact sequence
  // that used to make both untouched reports read as hand-edited.
  { slug: 'rca-meta-gate', title: 'Meta snapshot check', jiraKey: null }
]

const now = new Date().toISOString()

for (const c of CASES) {
  const existing = db.prepare(`SELECT id FROM cases WHERE slug = ?`).get(c.slug)
  if (existing) {
    db.prepare(`DELETE FROM rca_jobs WHERE case_slug = ?`).run(c.slug)
    db.prepare(`DELETE FROM cases WHERE slug = ?`).run(c.slug)
  }
  fs.rmSync(path.join(home, 'cases', c.slug), { recursive: true, force: true })

  db.prepare(
    `INSERT INTO cases (slug, title, jira_key, status, resolution, tags, created_at, updated_at)
     VALUES (?, ?, ?, 'open', NULL, '[]', ?, ?)`
  ).run(c.slug, c.title, c.jiraKey, now, now)

  for (const sub of ['evidence/.meta', 'artifacts/.meta', 'sessions', '.rca']) {
    fs.mkdirSync(path.join(home, 'cases', c.slug, sub), { recursive: true })
  }

  // `template_snapshot` NULL means "the default template" (`templateFromSnapshot`), which is
  // exactly what the gate wants — the toggles it clicks are the default sections.
  db.prepare(
    `INSERT INTO rca_jobs (case_slug, state, input_snapshot, raw_output, template_snapshot, created_at, finished_at)
     VALUES (?, 'done', ?, ?, NULL, ?, ?)`
  ).run(
    c.slug,
    JSON.stringify({ ...input, caseMeta: { ...input.caseMeta, slug: c.slug, title: c.title } }),
    '```json\n' + JSON.stringify(draft) + '\n```',
    now,
    now
  )
}

console.error(`seeded ${CASES.map((c) => c.slug).join(', ')} in ${home}`)
db.close()
