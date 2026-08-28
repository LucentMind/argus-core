import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, getCase } from '../caseService'
import { ingestArtifact } from '../ingest'
import { createImmediateQueue } from '../ingestQueue'
import { createDetection } from '../packs/detection'
import { createSession } from '../agent/sessionStore'
import { insertMessageFts } from '../ftsIndex'
import { upsertCaseSummary } from '../distill/summaries'
import { caseDir } from '../paths'

/** Homes + handles opened by seedArchivableCase(), torn down by cleanupArchiveFixtures(). */
const opened: Array<{ db: DatabaseSync; home: string }> = []

/** A case carrying one of everything archiving has to move or keep: an indexed evidence file
 *  containing "needle", a review artifact, a session with a transcript and an indexed chat
 *  message, a turn, a tool call, a finding pointing at that session/turn, and a case summary. */
export async function seedArchivableCase(): Promise<{
  db: DatabaseSync
  home: string
  slug: string
}> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-archive-')))
  const db = openDb(path.join(home, 'argus.db'))
  opened.push({ db, home })
  const slug = 'KAN-1'
  createCase(db, home, { slug, title: 'archivable' })
  const detection = createDetection()
  const queue = createImmediateQueue(db, home)

  const log = path.join(home, 'sample.log')
  fs.writeFileSync(log, 'line one\nthe needle is on this line\nline three\n')
  await ingestArtifact(db, home, detection, queue, slug, log)

  const artifact = path.join(home, 'ci-verify.log')
  fs.writeFileSync(artifact, 'review artifact contents\n')
  await ingestArtifact(db, home, detection, queue, slug, artifact, 'upload', {}, 'review')

  const caseId = getCase(db, slug)!.id
  const now = new Date().toISOString()
  const sessionId = createSession(db, slug, 'claude-agent-sdk').id
  const turnId = Number(
    db
      .prepare(
        `INSERT INTO turns (case_id, session_id, turn_index, status, created_at)
         VALUES (?, ?, 0, 'done', ?)`
      )
      .run(caseId, sessionId, now).lastInsertRowid
  )
  db.prepare(
    `INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, risk, decision, created_at)
     VALUES (?, ?, ?, 'Read', 'h', 'low', 'allow', ?)`
  ).run(caseId, sessionId, turnId, now)
  insertMessageFts(db, 'the needle came up in chat too', caseId, sessionId, turnId, 'user')

  fs.mkdirSync(path.join(caseDir(home, slug), 'sessions'), { recursive: true })
  // A transcript the rebuild can actually read: registerImportedSessions only indexes
  // `turn.started` and `assistant.message`, so a single {type:'message'} event produced a
  // session with title '', turn_count 0 and ZERO chat-FTS rows — meaning no test anywhere
  // could prove chat search comes back after a restore. These two events give it a title, a
  // turn count and two indexed messages.
  fs.writeFileSync(
    path.join(caseDir(home, slug), 'sessions', `${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: 'turn.started',
        caseId,
        caseSlug: slug,
        sessionId,
        payload: { userText: 'why does the needle keep coming back?' }
      }),
      JSON.stringify({
        type: 'assistant.message',
        caseId,
        caseSlug: slug,
        sessionId,
        payload: { text: 'the haystack answer, at length' }
      })
    ].join('\n') + '\n'
  )

  db.prepare(
    `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at)
     VALUES (?, ?, ?, 'a reviewed conclusion', 'accepted', ?)`
  ).run(caseId, sessionId, turnId, now)

  upsertCaseSummary(
    db,
    home,
    slug,
    {
      signature: 'needle failure',
      symptoms: 's',
      rootCause: 'r',
      fix: 'f',
      keywords: ['needle']
    },
    'fixed',
    '# summary\n'
  )
  return { db, home, slug }
}

/**
 * Add a SECOND session to a seeded case — its own transcript, turn, tool call and chat-index
 * row — and return its id.
 *
 * Multi-session is not decoration. Every interesting failure of the restore rebuild needs one
 * session already consumed and another still to go: a throw mid-loop, a kill after the loop.
 * The single-session fixture is precisely what hid two Critical defects, because with one
 * session there is no "the rest" to lose or to duplicate.
 *
 * Its chat text deliberately contains no "needle": tests that assert the FIRST session came
 * back use `searchMessages(…, 'needle')` as the probe, and a second hit would make the count
 * ambiguous.
 */
export function seedSecondSession(db: DatabaseSync, home: string, slug: string): number {
  const caseId = getCase(db, slug)!.id
  const now = new Date().toISOString()
  const sessionId = createSession(db, slug, 'claude-agent-sdk').id
  const turnId = Number(
    db
      .prepare(
        `INSERT INTO turns (case_id, session_id, turn_index, status, created_at)
         VALUES (?, ?, 0, 'done', ?)`
      )
      .run(caseId, sessionId, now).lastInsertRowid
  )
  db.prepare(
    `INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, risk, decision, created_at)
     VALUES (?, ?, ?, 'Bash', 'h2', 'medium', 'allow', ?)`
  ).run(caseId, sessionId, turnId, now)
  insertMessageFts(
    db,
    'a second conversation about the haystack',
    caseId,
    sessionId,
    turnId,
    'user'
  )
  fs.writeFileSync(
    path.join(caseDir(home, slug), 'sessions', `${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: 'turn.started',
        caseId,
        caseSlug: slug,
        sessionId,
        payload: { userText: 'a second conversation about the haystack' }
      }),
      JSON.stringify({
        type: 'assistant.message',
        caseId,
        caseSlug: slug,
        sessionId,
        payload: { text: 'a second answer, also at length' }
      })
    ].join('\n') + '\n'
  )
  return sessionId
}

/** Close every seeded database and remove its home. Call from afterEach: on Windows an open
 *  handle inside the tree makes fs.rmSync throw, so the close has to come first. */
export function cleanupArchiveFixtures(): void {
  while (opened.length) {
    const { db, home } = opened.pop()!
    try {
      db.close()
    } catch {
      /* already closed */
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
}

/** Everything an ordering test must find unchanged after a FAILED archive. Compared by value,
 *  so a partial delete shows up as a diff rather than as a count that happens to match. */
export function snapshotCase(
  db: DatabaseSync,
  home: string,
  slug: string
): Record<string, unknown> {
  const rec = getCase(db, slug)!
  const count = (table: string): number =>
    Number(
      (
        db.prepare(`SELECT count(*) AS n FROM ${table} WHERE case_id = ?`).get(rec.id) as {
          n: number
        }
      ).n
    )
  const walk = (dir: string, base = ''): string[] => {
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => {
        // .claude is the machine-local junction farm — never exported, never archived, and
        // following a junction here would walk out of the case dir entirely.
        if (!base && e.name === '.claude') return []
        if (e.isSymbolicLink()) return []
        return e.isDirectory()
          ? walk(path.join(dir, e.name), `${base}${e.name}/`)
          : [
              `${base}${e.name}:${crypto
                .createHash('sha256')
                .update(fs.readFileSync(path.join(dir, e.name)))
                .digest('hex')}`
            ]
      })
      .sort()
  }
  return {
    archivedAt: rec.archivedAt,
    archivePath: rec.archivePath,
    evidence: count('evidence'),
    sessions: count('sessions'),
    turns: count('turns'),
    toolCalls: count('tool_calls'),
    findings: count('findings'),
    findingPointers: db
      .prepare(`SELECT id, session_id, turn_id FROM findings WHERE case_id = ? ORDER BY id`)
      .all(rec.id),
    tree: walk(caseDir(home, slug))
  }
}
