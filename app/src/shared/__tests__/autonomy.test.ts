import { describe, expect, it } from 'vitest'
import { LANES, LANE_BASELINES, barFor, clearsBar, type LaneMetrics } from '../autonomy'
import { defaultSettings } from '../settings'

const metrics = (over: Partial<LaneMetrics>): LaneMetrics => ({
  lane: 'triage',
  windowDays: 30,
  decisions: 0,
  accepted: 0,
  acceptanceRate: null,
  costUsd: null,
  rejectReasons: {},
  depth: {},
  dataStart: null,
  ...over
})

describe('autonomy contract', () => {
  it('defines a baseline tier for every lane', () => {
    for (const lane of LANES) expect(LANE_BASELINES[lane]).toBeGreaterThanOrEqual(0)
  })

  it('settings default a bar for every lane via barFor', () => {
    const s = defaultSettings()
    expect(s.autonomy.windowDays).toBe(30)
    for (const lane of LANES) {
      expect(barFor(s.autonomy, lane)).toEqual({ minDecisions: 10, minAcceptanceRate: 0.8 })
    }
  })

  it('clearsBar requires both volume and rate', () => {
    const bar = { minDecisions: 10, minAcceptanceRate: 0.8 }
    expect(clearsBar(metrics({ decisions: 12, accepted: 10, acceptanceRate: 10 / 12 }), bar)).toBe(
      true
    )
    expect(clearsBar(metrics({ decisions: 9, accepted: 9, acceptanceRate: 1 }), bar)).toBe(false)
    expect(clearsBar(metrics({ decisions: 12, accepted: 9, acceptanceRate: 9 / 12 }), bar)).toBe(
      false
    )
    expect(clearsBar(metrics({ decisions: 0 }), bar)).toBe(false)
  })
})
