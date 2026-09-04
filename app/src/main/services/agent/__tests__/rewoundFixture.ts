import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '../../../../shared/agent-events'
import { caseDir } from '../../paths'
import { insertMessageFts } from '../../ftsIndex'

export const TAIL_TEXT = 'TAILSECRET-should-never-reach-the-model'
export const LIVE_TEXT = 'LIVEQUESTION-must-survive'
const now = '2026-09-04T00:00:00Z'

/**
 * One session: turn A (live, LIVE_TEXT) then turns B, C (rewound to A, TAIL_TEXT). Writes
 * the turn rows, the mirror JSONL and the messages_fts rows exactly as the live path would,
 * so every model-facing reader can be run against the same object.
 */
export function seedRewoundSession(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  caseId: number
): { caseId: number; sessionId: number; anchorId: number; tailIds: number[] } {
  const sessionId = Number(
    db
      .prepare(
        `INSERT INTO sessions (case_id, title, turn_count, created_at, updated_at) VALUES (?, 'fx', 3, ?, ?)`
      )
      .run(caseId, now, now).lastInsertRowid
  )
  const turn = (i: number, status: string, to: number | null): number =>
    Number(
      db
        .prepare(
          `INSERT INTO turns (case_id, session_id, turn_index, status, created_at, rewound_at, rewound_to_turn_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(caseId, sessionId, i, status, now, to == null ? null : now, to).lastInsertRowid
    )
  const anchorId = turn(1, 'success', null)
  const tailIds = [turn(2, 'rewound', anchorId), turn(3, 'rewound', anchorId)]
  const ev = (turnId: number, type: string, payload: unknown): AgentEvent =>
    ({
      eventId: `${turnId}-${type}`,
      caseId,
      caseSlug: slug,
      sessionId,
      turnId,
      ts: now,
      type,
      payload
    }) as AgentEvent
  const events: AgentEvent[] = [
    ev(anchorId, 'turn.started', { userText: LIVE_TEXT }),
    ev(anchorId, 'assistant.message', { text: 'live answer' }),
    ev(anchorId, 'turn.completed', {
      status: 'success',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      durationMs: 1
    }),
    ...tailIds.flatMap((id) => [
      ev(id, 'turn.started', { userText: TAIL_TEXT }),
      ev(id, 'assistant.message', { text: `${TAIL_TEXT} answer` }),
      ev(id, 'turn.completed', {
        status: 'success',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        durationMs: 1
      })
    ])
  ]
  const dir = path.join(caseDir(argusHome, slug), 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  )
  insertMessageFts(db, LIVE_TEXT, caseId, sessionId, anchorId, 'user')
  insertMessageFts(db, 'live answer', caseId, sessionId, anchorId, 'assistant')
  for (const id of tailIds) {
    insertMessageFts(db, TAIL_TEXT, caseId, sessionId, id, 'user')
    insertMessageFts(db, `${TAIL_TEXT} answer`, caseId, sessionId, id, 'assistant')
  }
  return { caseId, sessionId, anchorId, tailIds }
}
