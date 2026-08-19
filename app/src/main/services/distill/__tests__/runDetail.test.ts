import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { readRunDetail } from '../runDetail'

let db: DatabaseSync
beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
})

/** Inserts a distill_jobs row and returns its id. */
function insertJob(over: Record<string, string | number | null> = {}): number {
  const cols = {
    case_slug: 'c1',
    state: 'done',
    input_snapshot: '{"caseMeta":{"slug":"c1"}}',
    raw_output: '```json\n{}\n```',
    item_count: 0,
    created_at: '2026-08-19T00:00:00.000Z',
    stages_json: null as string | null,
    dropped_json: null as string | null,
    trajectory_json: null as string | null,
    ...over
  }
  const names = Object.keys(cols).join(', ')
  const marks = Object.keys(cols)
    .map(() => '?')
    .join(', ')
  const res = db
    .prepare(`INSERT INTO distill_jobs (${names}) VALUES (${marks})`)
    .run(...Object.values(cols))
  return Number(res.lastInsertRowid)
}

describe('readRunDetail', () => {
  it('returns null for an unknown job id', () => {
    expect(readRunDetail(db, 9999)).toBeNull()
  })

  it('parses a full v3 row into stages, drops and trajectory', () => {
    const id = insertJob({
      stages_json: JSON.stringify({
        dossier: { promptHash: 'h1', promptChars: 10, rawOutput: 'DOSSIER RAW' },
        candidates: { promptHash: 'h2', promptChars: 20, rawOutput: '[]', error: 'boom' }
      }),
      dropped_json: JSON.stringify([
        { type: 'skill-new', target: 'foo', title: 'Foo', reason: 'duplicate' }
      ]),
      trajectory_json: JSON.stringify([{ tool: 'read_session' }])
    })
    const d = readRunDetail(db, id)!
    expect(d.job.id).toBe(id)
    expect(d.stages!.dossier!.rawOutput).toBe('DOSSIER RAW')
    expect(d.stages!.candidates!.error).toBe('boom')
    expect(d.dropped).toEqual([
      { type: 'skill-new', target: 'foo', title: 'Foo', reason: 'duplicate' }
    ])
    expect(d.trajectory).toHaveLength(1)
    expect(d.inputSnapshotChars).toBe('{"caseMeta":{"slug":"c1"}}'.length)
  })

  it('yields stages null and dropped [] for a v2 row that recorded neither', () => {
    const d = readRunDetail(db, insertJob())!
    expect(d.stages).toBeNull()
    expect(d.dropped).toEqual([])
    expect(d.trajectory).toBeNull()
  })

  it('does not throw on a corrupt stages_json — the panel must open on a broken run', () => {
    const id = insertJob({ stages_json: '{not json', dropped_json: '[[[', trajectory_json: 'x' })
    const d = readRunDetail(db, id)!
    expect(d.stages).toBeNull()
    expect(d.dropped).toEqual([])
    expect(d.trajectory).toBeNull()
    expect(d.rawOutput).toBe('```json\n{}\n```')
  })

  it('treats a well-formed but wrong-shaped dropped_json as empty, not as one bogus row', () => {
    const d = readRunDetail(db, insertJob({ dropped_json: '{"not":"an array"}' }))!
    expect(d.dropped).toEqual([])
  })
})
