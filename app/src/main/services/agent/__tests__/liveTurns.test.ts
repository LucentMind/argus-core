import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { liveTurnIds, rewoundTurnsOf } from '../liveTurns'

let home: string, db: DatabaseSync, caseId: number, sessionId: number
const now = '2026-09-04T00:00:00Z'

function turn(status: string, extra: { rewound_to_turn_id?: number } = {}): number {
  const res = db
    .prepare(
      `INSERT INTO turns (case_id, session_id, turn_index, status, created_at, rewound_at, rewound_to_turn_id)
       VALUES (?, ?, 1, ?, ?, ?, ?)`
    )
    .run(
      caseId,
      sessionId,
      status,
      now,
      status === 'rewound' ? now : null,
      extra.rewound_to_turn_id ?? null
    )
  return Number(res.lastInsertRowid)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-live-turns-'))
  db = openDb(path.join(home, 'argus.db'))
  caseId = createCase(db, home, { slug: 'LT-1', title: 'x' }).id
  sessionId = Number(
    db
      .prepare(`INSERT INTO sessions (case_id, created_at, updated_at) VALUES (?, ?, ?)`)
      .run(caseId, now, now).lastInsertRowid
  )
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('liveTurnIds', () => {
  it('returns every turn except rewound ones', () => {
    const a = turn('success')
    const b = turn('error')
    const c = turn('rewound', { rewound_to_turn_id: b })
    expect([...liveTurnIds(db, sessionId)].sort()).toEqual([a, b].sort())
    expect(liveTurnIds(db, sessionId).has(c)).toBe(false)
  })
  it('rewoundTurnsOf lists rewound turns oldest first with their anchor', () => {
    const a = turn('success')
    const c = turn('rewound', { rewound_to_turn_id: a })
    const d = turn('rewound', { rewound_to_turn_id: a })
    expect(rewoundTurnsOf(db, sessionId)).toEqual([
      { turnId: c, toTurnId: a, at: now },
      { turnId: d, toTurnId: a, at: now }
    ])
  })
})
