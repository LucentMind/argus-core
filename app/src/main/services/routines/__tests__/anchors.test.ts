import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { ensureRoutineAnchor, forgetRoutineAnchor } from '../anchors'

let home: string
let db: DatabaseSync
const T0 = new Date('2026-08-08T01:00:00.000Z')
const T1 = new Date('2026-08-18T01:00:00.000Z')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-anchors-'))
  db = openDb(path.join(home, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const rows = (): { routine_id: string; anchored_at: string }[] =>
  db.prepare(`SELECT * FROM routine_anchors`).all() as unknown as {
    routine_id: string
    anchored_at: string
  }[]

describe('ensureRoutineAnchor', () => {
  it('records the first-seen instant and returns it', () => {
    expect(ensureRoutineAnchor(db, 'sweep', () => T0)).toBe(T0.toISOString())
    expect(rows()).toEqual([{ routine_id: 'sweep', anchored_at: T0.toISOString() }])
  })

  it('never moves an anchor it has already recorded, whatever the clock says later', () => {
    // The whole point of the row. A second call is what a restart, a payload() refresh and a
    // scheduler tick all look like from here — none of them may re-anchor the routine.
    ensureRoutineAnchor(db, 'sweep', () => T0)
    expect(ensureRoutineAnchor(db, 'sweep', () => T1)).toBe(T0.toISOString())
    expect(rows()).toHaveLength(1)
  })

  it('anchors each routine separately', () => {
    ensureRoutineAnchor(db, 'sweep', () => T0)
    ensureRoutineAnchor(db, 'digest', () => T1)
    expect(ensureRoutineAnchor(db, 'sweep', () => T1)).toBe(T0.toISOString())
    expect(ensureRoutineAnchor(db, 'digest', () => T0)).toBe(T1.toISOString())
  })
})

describe('forgetRoutineAnchor', () => {
  it('drops the row so the next sighting anchors afresh', () => {
    ensureRoutineAnchor(db, 'sweep', () => T0)
    forgetRoutineAnchor(db, 'sweep')
    expect(rows()).toEqual([])
    expect(ensureRoutineAnchor(db, 'sweep', () => T1)).toBe(T1.toISOString())
  })

  it('leaves other routines alone and is a no-op for an id that has none', () => {
    ensureRoutineAnchor(db, 'sweep', () => T0)
    expect(() => forgetRoutineAnchor(db, 'never-seen')).not.toThrow()
    forgetRoutineAnchor(db, 'digest')
    expect(rows()).toEqual([{ routine_id: 'sweep', anchored_at: T0.toISOString() }])
  })
})
