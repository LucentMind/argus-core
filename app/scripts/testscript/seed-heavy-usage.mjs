// Dev-only fixture: synthesize many cases + large session transcripts directly into an
// ARGUS_HOME so we can stress-test the suspected renderer memory leak (agentStore.byCase
// never evicts entries, and agent.history() replays a session's FULL mirror .jsonl on every
// open - see app/src/renderer/src/lib/agentStore.ts and app/src/main/services/agent/mirror.ts)
// without waiting for organic customer usage to reproduce it.
//
// This bypasses the agent entirely: no provider CLI is spawned, no LLM is called. It just
// inserts `cases`/`sessions` rows and writes sessions/<id>.jsonl mirror files in the exact
// shape the real app writes and reads (see app/src/shared/agent-events.ts).
//
// Usage:
//   node --experimental-sqlite app/scripts/testscript/seed-heavy-usage.mjs [options]
//
// Options:
//   --home <dir>              ARGUS_HOME to seed (default: $ARGUS_HOME or ~/Argus)
//   --cases <n>               number of synthetic cases (default 50)
//   --sessions-per-case <n>   sessions per case (default 3)
//   --events-per-session <n>  events per session .jsonl (default 4000)
//   --delta-chars <n>         chars per content.delta chunk (default 120)
//
// Then boot the real app against the seeded home (see .claude/skills/verify/SKILL.md) and
// click through the synthetic cases while watching process memory:
//   cd app && ARGUS_HOME='<home>' npm run dev
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const argusHome = arg('home', process.env.ARGUS_HOME ?? path.join(os.homedir(), 'Argus'))
const numCases = Number(arg('cases', 50))
const sessionsPerCase = Number(arg('sessions-per-case', 3))
const eventsPerSession = Number(arg('events-per-session', 4000))
const deltaChars = Number(arg('delta-chars', 120))

fs.mkdirSync(argusHome, { recursive: true })
const db = new DatabaseSync(path.join(argusHome, 'argus.db'))
db.exec(`PRAGMA journal_mode = WAL;`)
db.exec(`PRAGMA foreign_keys = ON;`)
// Mirrors the base schema in app/src/main/services/db.ts exactly (cases/sessions only - the
// full openDb() migration adds a few extra nullable columns and the fts5/turns/tool_calls
// tables on first real app boot, none of which listCases/listSessions/readSessionEvents need).
db.exec(`
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  jira_key TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  driver_cursor TEXT,
  driver_kind TEXT NOT NULL DEFAULT 'claude-agent-sdk',
  instance_id TEXT,
  model TEXT,
  title TEXT NOT NULL DEFAULT '',
  turn_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`)

const insertCase = db.prepare(
  `INSERT INTO cases (slug, title, status, resolution, tags, created_at, updated_at)
   VALUES (?, ?, 'open', NULL, '[]', ?, ?)`
)
const insertSession = db.prepare(
  `INSERT INTO sessions (case_id, driver_kind, turn_count, created_at, updated_at)
   VALUES (?, 'claude-agent-sdk', ?, ?, ?)`
)

const LOREM =
  'the request handler forwarded a stale cursor into the retry path before the session guard could reject it and '

function deltaText(n) {
  let s = ''
  while (s.length < n) s += LOREM
  return s.slice(0, n)
}

let totalEvents = 0
for (let c = 0; c < numCases; c++) {
  const slug = `SYN-${String(c + 1).padStart(4, '0')}`
  const now = new Date().toISOString()
  const caseRes = insertCase.run(slug, `Synthetic heavy-usage case ${c + 1}`, now, now)
  const caseId = Number(caseRes.lastInsertRowid)
  const caseDir = path.join(argusHome, 'cases', slug)
  fs.mkdirSync(path.join(caseDir, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(caseDir, 'evidence', '.meta'), { recursive: true })
  fs.writeFileSync(
    path.join(caseDir, 'case.json'),
    JSON.stringify(
      {
        slug,
        title: `Synthetic heavy-usage case ${c + 1}`,
        status: 'open',
        tags: [],
        createdAt: now,
        updatedAt: now
      },
      null,
      2
    )
  )
  fs.writeFileSync(path.join(caseDir, 'findings.md'), `# Findings - ${slug}\n`)

  for (let s = 0; s < sessionsPerCase; s++) {
    const turnCount = Math.max(1, Math.round(eventsPerSession / 20))
    const sessRes = insertSession.run(caseId, turnCount, now, now)
    const sessionId = Number(sessRes.lastInsertRowid)

    const lines = []
    let turnId = 0
    let ev = 0
    const pushEvent = (type, payload) => {
      ev++
      lines.push(
        JSON.stringify({
          eventId: `e${caseId}-${sessionId}-${ev}`,
          caseId,
          caseSlug: slug,
          sessionId,
          turnId: turnId || null,
          ts: now,
          type,
          payload
        })
      )
    }
    pushEvent('session.started', { model: 'claude-sonnet-5', resumed: false })
    while (ev < eventsPerSession) {
      turnId++
      pushEvent('turn.started', { userText: `Synthetic user turn ${turnId}` })
      const deltasThisTurn = Math.min(15, eventsPerSession - ev)
      for (let d = 0; d < deltasThisTurn; d++) {
        pushEvent('content.delta', { text: deltaText(deltaChars) })
      }
      pushEvent('assistant.message', { text: deltaText(deltaChars * deltasThisTurn) })
      pushEvent('turn.completed', {
        status: 'success',
        inputTokens: 120,
        outputTokens: 340,
        costUsd: 0.01,
        durationMs: 1200
      })
    }
    pushEvent('session.exited', { reason: 'stopped' })
    fs.writeFileSync(path.join(caseDir, 'sessions', `${sessionId}.jsonl`), lines.join('\n') + '\n')
    totalEvents += lines.length
  }
  if ((c + 1) % 10 === 0) console.log(`seeded ${c + 1}/${numCases} cases...`)
}

db.close()
console.log(
  `done: ${numCases} cases x ${sessionsPerCase} sessions, ${totalEvents} total events, home=${argusHome}`
)
