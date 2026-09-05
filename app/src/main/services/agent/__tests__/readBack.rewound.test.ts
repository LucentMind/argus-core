import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { caseDir } from '../../paths'
import { createDetection } from '../../packs/detection'
import { argusToolHandlers } from '../nativeTools'
import { buildHistoryDigest, filterLiveEvents } from '../historyDigest'
import { readSessionEvents } from '../mirror'
import { rewoundTurnIds } from '../liveTurns'
import { seedRewoundSession, TAIL_TEXT, LIVE_TEXT } from './rewoundFixture'

let tmp: string, argusHome: string, db: DatabaseSync
let fx: ReturnType<typeof seedRewoundSession>
const SLUG = 'RB-1'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-readback-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  const caseId = createCase(db, argusHome, { slug: SLUG, title: 'rb' }).id
  fx = seedRewoundSession(db, argusHome, SLUG, caseId)
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** `read_session_transcript` bound to one session, built the way the live tool table is. */
const transcriptOf = (sessionId: number): ((args: Record<string, unknown>) => Promise<unknown>) => {
  const tools = argusToolHandlers({
    db,
    argusHome,
    detection: createDetection(),
    caseId: fx.caseId,
    caseSlug: SLUG,
    sessionId,
    emitFinding: vi.fn(),
    githubWatermark: () => ({ enabled: false, text: '' })
  })
  return tools.read_session_transcript as (a: Record<string, unknown>) => Promise<unknown>
}

describe('rewound turns never reach the model', () => {
  it('history digest omits the tail', () => {
    const all = readSessionEvents(caseDir(argusHome, SLUG), fx.sessionId)
    const { events } = filterLiveEvents(all, rewoundTurnIds(db, fx.sessionId))
    const digest = buildHistoryDigest(events)
    expect(digest).toContain(LIVE_TEXT)
    expect(digest).not.toContain(TAIL_TEXT)
  })
  it('read_session_transcript omits the tail and marks the gap', async () => {
    const out = String(await transcriptOf(fx.sessionId)({}))
    expect(out).toContain(LIVE_TEXT)
    expect(out).not.toContain(TAIL_TEXT)
    expect(out).toMatch(/2 turns rewound by the user/)
  })
})

/**
 * C1's read-back half. An imported transcript's `turnId`s are the exporting machine's
 * autoincrements and `importCase` builds no `turns` rows for them, so "no local row names this
 * id" is not evidence of a rewind. Filtering on the live SET rather than the rewound one
 * emptied the whole transcript AND printed a gap marker asserting the user had rewound turns
 * nobody rewound — the marker is model-facing text, so this is a false statement put into the
 * agent's context, not just a missing feature.
 */
describe('an imported transcript (turn ids with no local rows)', () => {
  const IMPORTED_TEXT = 'IMPORTEDQUESTION-must-survive'
  let importedSessionId: number

  beforeEach(() => {
    importedSessionId = Number(
      db
        .prepare(
          `INSERT INTO sessions (case_id, title, turn_count, created_at, updated_at)
           VALUES (?, 'imported', 1, '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z')`
        )
        .run(fx.caseId).lastInsertRowid
    )
    const line = (turnId: number, type: string, payload: unknown): string =>
      JSON.stringify({
        eventId: `${turnId}-${type}`,
        caseId: fx.caseId,
        caseSlug: SLUG,
        sessionId: importedSessionId,
        turnId,
        ts: '2026-09-05T00:00:00Z',
        type,
        payload
      })
    fs.writeFileSync(
      path.join(caseDir(argusHome, SLUG), 'sessions', `${importedSessionId}.jsonl`),
      [
        line(90001, 'turn.started', { userText: IMPORTED_TEXT }),
        line(90001, 'assistant.message', { text: 'imported answer' })
      ].join('\n') + '\n'
    )
  })

  it('read_session_transcript prints the history and no gap marker', async () => {
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE session_id = ?`).get(importedSessionId)
    ).toEqual({ n: 0 }) // guard: no local row names turn 90001
    const out = String(await transcriptOf(importedSessionId)({}))
    expect(out).toContain(IMPORTED_TEXT)
    expect(out).not.toMatch(/rewound by the user/)
  })
})
