import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../services/db'
import { createCase } from '../services/caseService'
import { annotateHistoryOrphaned, type SessionDriverDeps } from '../services/agent/reviewFraming'

let tmp: string, argusHome: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sessions-orphaned-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'ORPH-1', title: 'orphaned' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function seedSession(db: DatabaseSync, opts: { turns: number; cursor: string | null }): number {
  const now = new Date().toISOString()
  const r = db
    .prepare(
      `INSERT INTO sessions (case_id, title, turn_count, driver_cursor, driver_kind, instance_id, created_at, updated_at)
       VALUES (1, '', ?, ?, 'claude-agent-sdk', NULL, ?, ?)`
    )
    .run(opts.turns, opts.cursor, now, now)
  return Number(r.lastInsertRowid)
}

const deps: SessionDriverDeps = {
  db: undefined as never,
  resolveDriver: () => ({ kind: 'claude-agent-sdk' }) as never,
  driverForInstance: () => ({ kind: 'claude-agent-sdk' }) as never
}

describe('annotateHistoryOrphaned', () => {
  it('marks only the sessions whose history the model cannot see', () => {
    const orphan = seedSession(db, { turns: 2, cursor: null })
    const healthy = seedSession(db, { turns: 2, cursor: 'abc' })
    const out = annotateHistoryOrphaned({ ...deps, db }, [
      { id: orphan, turnCount: 2 } as never,
      { id: healthy, turnCount: 2 } as never
    ])
    expect(out.map((s) => s.historyOrphaned)).toEqual([true, false])
  })

  it('preserves every other field and the input order', () => {
    const id = seedSession(db, { turns: 0, cursor: null })
    const [s] = annotateHistoryOrphaned({ ...deps, db }, [
      { id, title: 'keep me', turnCount: 0 } as never
    ])
    expect(s.title).toBe('keep me')
    expect(s.historyOrphaned).toBe(false)
  })
})
