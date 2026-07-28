import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { clearPrStatus, readPrStatuses, writePrStatus } from '../prStatusCache'
import type { PrStatus } from '../../../shared/prStatus'

let db: DatabaseSync
let home: string

const status = (over: Partial<PrStatus> = {}): PrStatus => ({
  owner: 'acme',
  repo: 'widget',
  number: 42,
  url: 'https://github.com/acme/widget/pull/42',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  rollup: 'passing',
  checks: [{ name: 'build', bucket: 'pass', url: null, jobId: null }],
  fetchedAt: '2026-07-27T12:00:00.000Z',
  error: null,
  ...over
})

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prstatus-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
  createCase(db, home, { slug: 'c2', title: 'Case 2' })
})

describe('prStatusCache', () => {
  it('round-trips a status', () => {
    writePrStatus(db, 'c1', status())
    expect(readPrStatuses(db, ['c1'])['c1']).toEqual(status())
  })

  it('replaces the row rather than accumulating rows', () => {
    writePrStatus(db, 'c1', status({ rollup: 'passing' }))
    writePrStatus(db, 'c1', status({ rollup: 'failing' }))
    expect(readPrStatuses(db, ['c1'])['c1'].rollup).toBe('failing')
    const n = db.prepare(`SELECT COUNT(*) AS n FROM pr_status_cache`).get() as { n: number }
    expect(n.n).toBe(1)
  })

  it('omits cases with no cached row instead of returning nulls', () => {
    writePrStatus(db, 'c1', status())
    const map = readPrStatuses(db, ['c1', 'c2'])
    expect(Object.keys(map)).toEqual(['c1'])
  })

  it('reads many cases at once', () => {
    writePrStatus(db, 'c1', status())
    writePrStatus(db, 'c2', status({ number: 7, rollup: 'running' }))
    const map = readPrStatuses(db, ['c1', 'c2'])
    expect(map['c2'].number).toBe(7)
    expect(map['c2'].rollup).toBe('running')
  })

  it('returns nothing for an empty slug list without touching the db', () => {
    expect(readPrStatuses(db, [])).toEqual({})
  })

  it('clears one case', () => {
    writePrStatus(db, 'c1', status())
    writePrStatus(db, 'c2', status())
    clearPrStatus(db, 'c1')
    expect(Object.keys(readPrStatuses(db, ['c1', 'c2']))).toEqual(['c2'])
  })

  it('is dropped with the case', () => {
    writePrStatus(db, 'c1', status())
    db.prepare(`DELETE FROM cases WHERE slug = ?`).run('c1')
    expect(readPrStatuses(db, ['c1'])).toEqual({})
  })

  it('ignores an unknown slug rather than throwing', () => {
    expect(() => clearPrStatus(db, 'nope')).not.toThrow()
    expect(readPrStatuses(db, ['nope'])).toEqual({})
  })
})
