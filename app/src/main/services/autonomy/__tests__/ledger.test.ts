import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { addEvent, ackEvent, currentTier, listEvents, unackedDemotions } from '../ledger'
import type { LaneMetrics } from '../../../../shared/autonomy'

let dir: string
let db: DatabaseSync
const snap: LaneMetrics = {
  lane: 'triage',
  windowDays: 30,
  decisions: 12,
  accepted: 11,
  acceptanceRate: 11 / 12,
  costUsd: 1.25,
  rejectReasons: {},
  depth: {},
  dataStart: null
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ledger-'))
  db = openDb(path.join(dir, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('autonomy ledger', () => {
  it('resolves the baseline tier with no events', () => {
    expect(currentTier(db, 'triage')).toBe(1)
    expect(currentTier(db, 'review-finding')).toBe(3)
  })

  it('addEvent derives fromTier, persists the snapshot, and moves the tier', () => {
    const e = addEvent(db, {
      lane: 'triage',
      kind: 'promote',
      toTier: 2,
      note: 'cleared bar Q3',
      metricsSnapshot: snap,
      now: new Date('2026-08-12T10:00:00Z')
    })
    expect(e.fromTier).toBe(1)
    expect(currentTier(db, 'triage')).toBe(2)
    const listed = listEvents(db, 'triage')
    expect(listed).toHaveLength(1)
    expect(listed[0].metricsSnapshot.decisions).toBe(12)
    expect(listed[0].createdAt).toBe('2026-08-12T10:00:00.000Z')
  })

  it('rejects a no-op tier change', () => {
    expect(() =>
      addEvent(db, { lane: 'rca', kind: 'promote', toTier: 1, metricsSnapshot: snap })
    ).toThrow(/no-op/)
  })

  it('counts and acks unacknowledged auto-demotions', () => {
    addEvent(db, { lane: 'triage', kind: 'promote', toTier: 2, metricsSnapshot: snap })
    const d = addEvent(db, {
      lane: 'triage',
      kind: 'auto-demote',
      toTier: 1,
      metricsSnapshot: snap
    })
    expect(unackedDemotions(db)).toBe(1)
    ackEvent(db, d.id, new Date('2026-08-12T11:00:00Z'))
    expect(unackedDemotions(db)).toBe(0)
    expect(listEvents(db, 'triage')[0].acknowledgedAt).toBe('2026-08-12T11:00:00.000Z')
  })
})
