import { describe, it, expect } from 'vitest'
import { createTurnCostTracker } from '../turnCost'

// `result.total_cost_usd` is the query()'s running total, and a resumed query() continues from
// the saved total (sdk.d.ts 0.3.281; measured in EVIDENCE.md).
describe('createTurnCostTracker', () => {
  it('turns a fresh session’s running totals into per-turn cost', () => {
    const t = createTurnCostTracker(0)
    expect(t(0.01, false)).toEqual({ costUsd: 0.01, sdkTotalCostUsd: 0.01 })
    expect(t(0.03, false)).toEqual({ costUsd: 0.02, sdkTotalCostUsd: 0.03 })
  })

  it('subtracts the resumed conversation’s saved total from the first result', () => {
    const t = createTurnCostTracker(0.05)
    expect(t(0.07, false)).toEqual({ costUsd: 0.02, sdkTotalCostUsd: 0.07 })
  })

  // e.g. a resumed transcript from an older CLI that saved no total.
  it('treats a total below the previous one as a reset', () => {
    const resumed = createTurnCostTracker(0.05)
    expect(resumed(0.01, false)).toEqual({ costUsd: 0.01, sdkTotalCostUsd: 0.01 })
    const cleared = createTurnCostTracker(0)
    cleared(0.03, false)
    expect(cleared(0.004, false)).toEqual({ costUsd: 0.004, sdkTotalCostUsd: 0.004 })
  })

  // e.g. /clear mints a new session id; its total restarts even if it exceeds the previous one.
  it('starts from zero when the result belongs to a different conversation', () => {
    const t = createTurnCostTracker(0)
    expect(t(0.03, false, 'conv-1')).toEqual({ costUsd: 0.03, sdkTotalCostUsd: 0.03 })
    expect(t(0.05, false, 'conv-2')).toEqual({ costUsd: 0.05, sdkTotalCostUsd: 0.05 })
    expect(t(0.06, false, 'conv-2')).toEqual({ costUsd: 0.01, sdkTotalCostUsd: 0.06 })
    // A result without a conversation id keeps the last one.
    expect(t(0.08, false, null)).toEqual({ costUsd: 0.02, sdkTotalCostUsd: 0.08 })
  })

  it('subtracts the baseline only for the resumed conversation itself', () => {
    const same = createTurnCostTracker(0.05, 'resumed')
    expect(same(0.07, false, 'resumed')).toEqual({ costUsd: 0.02, sdkTotalCostUsd: 0.07 })
    const other = createTurnCostTracker(0.05, 'resumed')
    expect(other(0.07, false, 'fresh')).toEqual({ costUsd: 0.07, sdkTotalCostUsd: 0.07 })
  })

  // "Crash/startup-error results may carry zeroed values" — not a real total.
  it('ignores a zeroed error result', () => {
    const t = createTurnCostTracker(0)
    t(0.03, false)
    expect(t(0, true)).toEqual({ costUsd: 0, sdkTotalCostUsd: null })
    expect(t(0.05, false)).toEqual({ costUsd: 0.02, sdkTotalCostUsd: 0.05 })
  })

  it('reports unknown cost for a missing or malformed total, without moving the baseline', () => {
    const t = createTurnCostTracker(0)
    t(0.03, false)
    expect(t(undefined, false)).toEqual({ costUsd: null, sdkTotalCostUsd: null })
    expect(t(Number.NaN, false)).toEqual({ costUsd: null, sdkTotalCostUsd: null })
    expect(t(-1, false)).toEqual({ costUsd: null, sdkTotalCostUsd: null })
    expect(t(0.04, false)).toEqual({ costUsd: 0.01, sdkTotalCostUsd: 0.04 })
  })

  it('treats a non-finite or negative baseline as zero', () => {
    expect(createTurnCostTracker(Number.NaN)(0.01, false).costUsd).toBe(0.01)
    expect(createTurnCostTracker(-3)(0.01, false).costUsd).toBe(0.01)
  })

  it('rounds away float noise from the subtraction', () => {
    const t = createTurnCostTracker(0.1)
    // 0.3 - 0.1 === 0.19999999999999998 in IEEE-754
    expect(t(0.3, false).costUsd).toBe(0.2)
  })

  // The EVIDENCE.md Haiku run verbatim: two turns of one query(), then a resume.
  it('reproduces the measured Haiku session', () => {
    const live = createTurnCostTracker(0)
    expect(live(0.02763, false).costUsd).toBe(0.02763)
    expect(live(0.030052099999999998, false).costUsd).toBe(0.0024221)
    const resumed = createTurnCostTracker(0.030052099999999998)
    expect(resumed(0.031809899999999995, false).costUsd).toBe(0.0017578)
  })
})
