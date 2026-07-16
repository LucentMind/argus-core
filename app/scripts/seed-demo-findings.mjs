// Dev-only fixture: seed 3 demo findings (accepted / rejected / pending, each
// with citations) into an EXISTING case so the FindingsPane cards can be
// eyeballed without driving the agent. Rows + findings.md markers stay in sync.
//
// Usage:
//   node --experimental-sqlite app/scripts/seed-demo-findings.mjs <SLUG> [ARGUS_HOME]
// ARGUS_HOME defaults to $ARGUS_HOME or ~/Argus.
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const slug = process.argv[2]
const argusHome = process.argv[3] ?? process.env.ARGUS_HOME ?? path.join(os.homedir(), 'Argus')
if (!slug) {
  console.error(
    'usage: node --experimental-sqlite app/scripts/seed-demo-findings.mjs <SLUG> [ARGUS_HOME]'
  )
  process.exit(1)
}

const db = new DatabaseSync(path.join(argusHome, 'argus.db'))
const kase = db.prepare('SELECT id FROM cases WHERE slug = ?').get(slug)
if (!kase) {
  console.error(`no such case: ${slug} — create it in the app first`)
  process.exit(1)
}

const demo = [
  {
    title: 'Tile view crashes on null route ID',
    session: 4,
    state: 'accepted',
    body: 'The tile renderer dereferences `route.id` before the guard that handles unrouted tiles, so a freshly-created tile throws on first paint.\n\nRepro: create a tile, leave its route unassigned, switch cases and back.\nSee [TileView.tsx:88] and [router.ts:12].'
  },
  {
    title: 'Race condition in refresh handler when two syncs overlap',
    session: 4,
    state: 'rejected',
    body: 'Two overlapping Jira syncs both pass the `isRefreshing` check before either sets the flag, so the second clobbers the first’s summary note.\nSee [JiraRefreshButton.tsx:41].'
  },
  {
    title: 'Missing retry on Jira 429 response',
    session: 5,
    state: 'pending',
    body: 'The Jira client treats HTTP 429 as a terminal error instead of backing off, so a rate-limited sync fails the whole turn. See [jiraClient.ts:210].'
  }
]

const insert = db.prepare(
  `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, reviewed_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
)
const parts = [`# Findings — ${slug}\n`]
for (const f of demo) {
  const now = new Date().toISOString()
  const reviewedAt = f.state === 'pending' ? null : now
  const res = insert.run(kase.id, f.session, null, f.title, f.state, reviewedAt, now)
  const id = Number(res.lastInsertRowid)
  parts.push(
    `\n<!-- finding:${id} -->\n## ${f.title}\n_${now} · session ${f.session}_\n\n${f.body}\n`
  )
}
fs.writeFileSync(path.join(argusHome, 'cases', slug, 'findings.md'), parts.join(''))
console.log(`seeded ${demo.length} findings into ${slug} (rows + findings.md markers in sync)`)
db.close()
