import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { AutonomyEvaluator } from '../evaluator'
import { addEvent, currentTier, listEvents } from '../ledger'
import { defaultSettings } from '../../../../shared/settings'
import type { LaneMetrics } from '../../../../shared/autonomy'

let home: string
let db: DatabaseSync
const NOW = new Date('2026-08-12T12:00:00Z')
const snap: LaneMetrics = {
  lane: 'triage', windowDays: 30, decisions: 12, accepted: 12,
  acceptanceRate: 1, costUsd: null, rejectReasons: {}, depth: {}, dataStart: null
}

/** N routine-case decisions inside the window, `accepted` of them accepted. */
function seedTriage(n: number, accepted: number, dayOffset = 0): void {
  for (let i = 0; i < n; i++) {
    const slug = `r-${dayOffset}-${i}`
    const decided = new Date(NOW.getTime() - (2 + dayOffset) * 24 * 3600 * 1000).toISOString()
    db.prepare(
      `INSERT INTO cases (slug, title, status, origin, review_state, triaged_at, created_at, updated_at)
       VALUES (?, ?, 'open', 'routine', ?, ?, ?, ?)`
    ).run(slug, slug, i < accepted ? null : 'draft', decided, decided, decided)
  }
}

function makeEvaluator(onChanged = vi.fn()) {
  return {
    ev: new AutonomyEvaluator({
      db, argusHome: home, settings: () => defaultSettings(), onChanged, now: () => NOW
    }),
    onChanged
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-eval-'))
  db = openDb(path.join(home, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('AutonomyEvaluator', () => {
  it('never demotes a lane sitting at its baseline', () => {
    seedTriage(12, 2) // terrible acceptance, but tier == baseline
    const { ev, onChanged } = makeEvaluator()
    expect(ev.evaluateNow()).toEqual([])
    expect(currentTier(db, 'triage')).toBe(1)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('never demotes on sparse data', () => {
    addEvent(db, { lane: 'triage', kind: 'promote', toTier: 2, metricsSnapshot: snap })
    seedTriage(5, 0) // 0% acceptance but < minDecisions(10)
    const { ev } = makeEvaluator()
    expect(ev.evaluateNow()).toEqual([])
    expect(currentTier(db, 'triage')).toBe(2)
  })

  it('demotes one tier below bar, fires onChanged, and does not refire without new decisions', () => {
    addEvent(db, { lane: 'triage', kind: 'promote', toTier: 2, metricsSnapshot: snap })
    seedTriage(12, 6) // 50% < 80%
    const { ev, onChanged } = makeEvaluator()
    const events = ev.evaluateNow()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('auto-demote')
    expect(events[0].toTier).toBe(1)
    expect(currentTier(db, 'triage')).toBe(1)
    expect(onChanged).toHaveBeenCalledTimes(1)
    // still below bar at baseline now — and even after re-promoting, no NEW decision ⇒ no refire
    addEvent(db, { lane: 'triage', kind: 'promote', toTier: 2, metricsSnapshot: snap })
    expect(ev.evaluateNow()).toEqual([])
    expect(currentTier(db, 'triage')).toBe(2)
  })

  it('refires once a new decision lands after the demotion', () => {
    addEvent(db, { lane: 'triage', kind: 'promote', toTier: 2, metricsSnapshot: snap })
    seedTriage(12, 6)
    const { ev } = makeEvaluator()
    ev.evaluateNow()
    addEvent(db, { lane: 'triage', kind: 'promote', toTier: 2, metricsSnapshot: snap })
    // one more dismissal, decided AFTER the auto-demote event: stamp triaged_at at NOW + 1s
    // so the single-fire guard detects a fresh decision (decidedAt > auto-demote's createdAt)
    const AFTER = new Date(NOW.getTime() + 1000).toISOString()
    db.prepare(
      `INSERT INTO cases (slug, title, status, origin, review_state, triaged_at, created_at, updated_at)
       VALUES ('fresh', 'fresh', 'open', 'routine', 'draft', ?, ?, ?)`
    ).run(AFTER, NOW.toISOString(), NOW.toISOString())
    const events = ev.evaluateNow()
    expect(events).toHaveLength(1)
    expect(currentTier(db, 'triage')).toBe(1)
  })

  it('evaluateSoon debounces to a single evaluation', async () => {
    vi.useFakeTimers()
    addEvent(db, { lane: 'triage', kind: 'promote', toTier: 2, metricsSnapshot: snap })
    seedTriage(12, 6)
    const { ev } = makeEvaluator()
    ev.evaluateSoon()
    ev.evaluateSoon()
    ev.evaluateSoon()
    await vi.advanceTimersByTimeAsync(1100)
    expect(listEvents(db, 'triage').filter((e) => e.kind === 'auto-demote')).toHaveLength(1)
    ev.dispose()
    vi.useRealTimers()
  })
})
