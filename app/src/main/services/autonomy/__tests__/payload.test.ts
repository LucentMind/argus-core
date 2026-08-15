import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { buildAutonomyPayload } from '../payload'
import { addEvent } from '../ledger'
import { defaultSettings } from '../../../../shared/settings'
import type { LaneMetrics } from '../../../../shared/autonomy'

let home: string
let db: DatabaseSync
const snap: LaneMetrics = {
  lane: 'rca',
  windowDays: 30,
  decisions: 0,
  accepted: 0,
  acceptanceRate: null,
  costUsd: null,
  rejectReasons: {},
  depth: {},
  dataStart: null
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-payload-'))
  db = openDb(path.join(home, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('buildAutonomyPayload', () => {
  it('assembles all four lanes with tiers, bars, events, and global tiles', () => {
    addEvent(db, { lane: 'rca', kind: 'promote', toTier: 2, metricsSnapshot: snap })
    const p = buildAutonomyPayload({
      db,
      argusHome: home,
      settings: () => defaultSettings(),
      argusVersion: '0.0.0-test',
      now: () => new Date('2026-08-12T12:00:00Z')
    })
    expect(p.contractVersion).toBe(1)
    expect(p.argusVersion).toBe('0.0.0-test')
    expect(p.instanceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(p.windowDays).toBe(30)
    expect(p.lanes.map((l) => l.lane)).toEqual(['triage', 'distill', 'review-finding', 'rca'])
    const rca = p.lanes.find((l) => l.lane === 'rca')!
    expect(rca.tier).toBe(2)
    expect(rca.baseline).toBe(1)
    expect(rca.events).toHaveLength(1)
    expect(rca.bar).toEqual({ minDecisions: 10, minAcceptanceRate: 0.8 })
    expect(p.unackedDemotions).toBe(0)
    expect(p.timeInTriage.cases).toBe(0)
    expect(p.resolvedCases).toBe(0)
    // the whole payload must survive the IPC boundary
    expect(() => JSON.stringify(p)).not.toThrow()
  })
})
