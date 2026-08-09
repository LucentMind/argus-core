import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { readRoutineCursor, writeRoutineCursor, forgetRoutineCursor } from '../cursors'

let tmp: string
let db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursors-'))
  db = openDb(path.join(tmp, 'a.sqlite'))
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('routine cursors', () => {
  it('reads null for a routine that has never run a scoped run', () => {
    expect(readRoutineCursor(db, 'nightly')).toBeNull()
  })

  it('writes and reads back a cursor', () => {
    writeRoutineCursor(db, 'nightly', '2026-08-01T00:00:00.000Z', () => new Date('2026-08-08'))
    expect(readRoutineCursor(db, 'nightly')).toBe('2026-08-01T00:00:00.000Z')
  })

  it('OVERWRITES rather than inserting a second row, so one routine has one cursor', () => {
    writeRoutineCursor(db, 'nightly', 'a', () => new Date('2026-08-08'))
    writeRoutineCursor(db, 'nightly', 'b', () => new Date('2026-08-09'))
    expect(readRoutineCursor(db, 'nightly')).toBe('b')
    const n = db.prepare(`SELECT COUNT(*) AS n FROM routine_cursors`).get() as { n: number }
    expect(n.n).toBe(1)
  })

  it('keeps cursors of different routines apart', () => {
    writeRoutineCursor(db, 'a', '1', () => new Date('2026-08-08'))
    writeRoutineCursor(db, 'b', '2', () => new Date('2026-08-08'))
    expect(readRoutineCursor(db, 'a')).toBe('1')
    expect(readRoutineCursor(db, 'b')).toBe('2')
  })

  /**
   * A blank cursor is not "no cursor yet" — `readRoutineCursor` hands it back and every consumer
   * tests it for truthiness, so it silently means "restart the scope from the beginning", where
   * every result is already attempted: zero items, `ok`, permanently stalled. A Jira issue with
   * no `fields` block produces exactly that value (the Jira REST client — named indirectly for
   * the same grep reason as the docblock in cursors.ts).
   */
  it('REFUSES to write an empty cursor rather than resetting the routine', () => {
    expect(() => writeRoutineCursor(db, 'nightly', '', () => new Date('2026-08-08'))).toThrow(
      /empty cursor/
    )
    expect(readRoutineCursor(db, 'nightly')).toBeNull()
  })

  it('refuses a whitespace-only cursor the same way', () => {
    expect(() => writeRoutineCursor(db, 'nightly', '   ', () => new Date('2026-08-08'))).toThrow(
      /empty cursor/
    )
    expect(readRoutineCursor(db, 'nightly')).toBeNull()
  })

  it('leaves a good cursor in place when a later blank write is refused', () => {
    writeRoutineCursor(db, 'nightly', '2026-08-01T00:00:00.000Z', () => new Date('2026-08-08'))
    expect(() => writeRoutineCursor(db, 'nightly', '', () => new Date('2026-08-09'))).toThrow()
    expect(readRoutineCursor(db, 'nightly')).toBe('2026-08-01T00:00:00.000Z')
  })

  it('forgets a cursor, so a routine recreated under the same id starts over', () => {
    writeRoutineCursor(db, 'nightly', 'a', () => new Date('2026-08-08'))
    forgetRoutineCursor(db, 'nightly')
    expect(readRoutineCursor(db, 'nightly')).toBeNull()
  })
})
