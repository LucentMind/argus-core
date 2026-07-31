#!/usr/bin/env node
/**
 * Fixture for `cdp-dashboard-polish.mjs`.
 *
 * Narrow and standalone for the same reason as `dynamicThemeViews.mjs` and
 * `findings-layout-fixture.mjs`: this shape exists to make one gate's assertions checkable, and
 * folding it into `seed-test-home.mjs` would let an unrelated change to that broad seed drift it
 * out from under this gate.
 *
 * What the gate needs:
 *   - one case per priority glyph (Highest/High/Medium/Low/Lowest), so all five map at once
 *   - one case whose priority is outside every scheme we map ("Escalated"), to see the text-chip
 *     fallback rendered rather than argued about
 *   - one case with no priority at all, which must show neither glyph nor chip
 *   - a closed case, so the Show closed control at the far right has something to reveal
 *   - a long title, so the -15% card height is judged against a two-line clamp, not a short one
 *
 * Usage:
 *   ARGUS_HOME=/path/to/home node scripts/dashboard-polish-fixture.mjs
 *
 * Requires an ARGUS_HOME whose argus.db has been through the app's startup migrations — boot the
 * app against it once first. `jira_priority` and `active_mode` are migrations, not part of the
 * base SCHEMA, so a never-opened db has neither column.
 *
 * Idempotent: re-running deletes these slugs and reinserts them.
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

const CASES = [
  ['NAV-101-heading-drift', 'Heading drifts after tunnel exit', 'Highest', 'analyzing'],
  ['NAV-102-route-missing', 'Route disappears when rerouting mid-manoeuvre', 'High', 'open'],
  [
    'NAV-103-stopover-early',
    'CLONE - [NAV] Stopover reached too early and the remaining route is silently dropped',
    'Medium',
    'open'
  ],
  ['HMT-104-map-tiles', 'Map tiles load slowly on cold start', 'Low', 'rca-drafted'],
  ['HMT-105-toast-copy', 'Toast copy is truncated in German', 'Lowest', 'open'],
  ['HMT-106-burst-token', 'Burst token refresh races the session restore', 'Escalated', 'open'],
  ['HMT-107-no-priority', 'Unlinked case with no Jira priority', null, 'open'],
  ['HMT-108-old-crash', 'Startup crash on locale switch', 'High', 'closed']
]

const db = new DatabaseSync(dbPath)
const now = new Date().toISOString()

db.exec('BEGIN')
try {
  const del = db.prepare('DELETE FROM cases WHERE slug = ?')
  for (const [slug] of CASES) del.run(slug)

  const ins = db.prepare(
    `INSERT INTO cases (slug, title, jira_key, status, resolution, jira_priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const [slug, title, priority, status] of CASES) {
    ins.run(
      slug,
      title,
      slug.split('-').slice(0, 2).join('-'),
      status,
      status === 'closed' ? 'wont-fix' : null,
      priority,
      now,
      now
    )
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  throw err
}

console.log(`seeded ${CASES.length} cases into ${dbPath}`)
db.close()
