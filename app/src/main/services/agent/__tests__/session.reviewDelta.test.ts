// app/src/main/services/agent/__tests__/session.reviewDelta.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createSession } from '../sessionStore'
import { createDetection } from '../../packs/detection'
import { CaseSession } from '../session'
import { ReviewDeltaQueue } from '../reviewDelta'
import { reviewFinding } from '../../findings'
import { CLAUDE_TOOL_TAXONOMY } from '../risk'
import { PERMISSION_MODES } from '../../../../shared/settings'
import type { AgentDriver, DriverSession } from '../driver'
import type { AgentEvent } from '../../../../shared/agent-events'

/** A driver that records what CaseSession hands the provider — the delta lives on exactly this
 *  wire and nowhere else (same shape as session.historyReplay.test.ts's recordingDriver). */
function recordingDriver(): { driver: AgentDriver; sent: string[] } {
  const sent: string[] = []
  const driver: AgentDriver = {
    kind: 'claude-agent-sdk',
    toolTaxonomy: CLAUDE_TOOL_TAXONOMY,
    authFixHint: 'stub',
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: true,
      costReporting: true,
      headlessOneShot: false,
      systemPromptTransport: 'systemPrompt.append',
      subagents: 'configurable',
      branching: 'native'
    },
    createSession(): DriverSession {
      return {
        events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
        send: (text: string) => void sent.push(text),
        interrupt: async () => {},
        end: () => {}
      } as DriverSession
    },
    probeAuth: async () => ({ ok: true, detail: 'stub' })
  }
  return { driver, sent }
}

let tmp: string, argusHome: string, db: DatabaseSync
let caseId: number
let sessionId: number
let events: AgentEvent[]

function seedFinding(sid: number): number {
  const res = db
    .prepare(
      `INSERT INTO findings (case_id, session_id, summary, review_state, created_at) VALUES (?, ?, 'Race in parser', 'pending', 'x')`
    )
    .run(caseId, sid)
  return Number(res.lastInsertRowid)
}

function makeSession(
  queue: ReviewDeltaQueue,
  mode: 'investigation' | 'review' = 'investigation'
): { session: CaseSession; sent: string[] } {
  const { driver, sent } = recordingDriver()
  const session = new CaseSession({
    db,
    argusHome,
    detection: createDetection(),
    caseId,
    caseSlug: 'NAV-1',
    sessionId,
    mode,
    workspaceRoots: [],
    skillsRoots: [],
    emit: (e) => events.push(e),
    driver,
    resumeCursor: null,
    reviewDelta: queue,
    githubWatermark: () => ({ enabled: false, text: '' })
  })
  return { session, sent }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-delta-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  caseId = createCase(db, argusHome, { slug: 'NAV-1', title: 't' }).id
  sessionId = createSession(db, 'NAV-1', 'claude-agent-sdk').id
  events = []
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('CaseSession review delta', () => {
  it('prefixes the next driver send with the queued reviews, once, and keeps the transcript text raw', () => {
    const queue = new ReviewDeltaQueue()
    const id = seedFinding(sessionId)
    queue.note(reviewFinding(db, id, 'rejected', { tag: 'wrong', note: 'old build' })!)
    const { session, sent } = makeSession(queue)
    session.send('what now?')
    expect(sent[0]).toContain(
      `- Finding #${id} "Race in parser" — REJECTED by the user (wrong: old build).`
    )
    expect(sent[0].endsWith('what now?')).toBe(true)
    const started = events.find((e) => e.type === 'turn.started') as Extract<
      AgentEvent,
      { type: 'turn.started' }
    >
    expect(started.payload.userText).toBe('what now?')
    session.send('and then?')
    expect(sent[1]).toBe('and then?')
  })

  it('a review-mode session does not drain investigation reviews', () => {
    const queue = new ReviewDeltaQueue()
    const id = seedFinding(sessionId) // findings.mode defaults to investigation
    queue.note(reviewFinding(db, id, 'accepted')!)
    const { session, sent } = makeSession(queue, 'review')
    session.send('review please')
    expect(sent[0]).toBe('review please')
    expect(queue.drain(caseId, 'investigation')).toContain(`#${id}`)
  })

  it('sends plain text when no queue is wired', () => {
    const { driver, sent } = recordingDriver()
    const session = new CaseSession({
      db,
      argusHome,
      detection: createDetection(),
      caseId,
      caseSlug: 'NAV-1',
      sessionId,
      workspaceRoots: [],
      skillsRoots: [],
      emit: (e) => events.push(e),
      driver,
      resumeCursor: null,
      githubWatermark: () => ({ enabled: false, text: '' })
    })
    session.send('hello')
    expect(sent[0]).toBe('hello')
  })
})
