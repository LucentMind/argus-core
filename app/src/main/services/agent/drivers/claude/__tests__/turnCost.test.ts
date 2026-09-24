import { describe, it, expect } from 'vitest'
import { createTurnCostTracker } from '../turnCost'

// sdk.d.ts (0.3.281): `result.total_cost_usd` is the query() call's RUNNING total — "each result
// carries the running total so far, so read the latest result rather than summing across
// results" — and a resumed query() "continues from the total its transcript saved".
// Measured in drivers/claude/__fixtures__/EVIDENCE.md.
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

  // A resumed transcript that carried no saved total (written by an older CLI), or a
  // mid-session /clear: the SDK's total restarted, so all of it belongs to this turn.
  it('treats a total below the previous one as a reset', () => {
    const resumed = createTurnCostTracker(0.05)
    expect(resumed(0.01, false)).toEqual({ costUsd: 0.01, sdkTotalCostUsd: 0.01 })
    const cleared = createTurnCostTracker(0)
    cleared(0.03, false)
    expect(cleared(0.004, false)).toEqual({ costUsd: 0.004, sdkTotalCostUsd: 0.004 })
  })

  // "Crash/startup-error results may carry zeroed values" — not a real total, so it must
  // neither reset the running total nor be persisted as a resume baseline.
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

  // The EVIDENCE.md Haiku run, fed through verbatim: two turns of one query(), then a resume
  // seeded with the second total.
  it('reproduces the measured Haiku session', () => {
    const live = createTurnCostTracker(0)
    expect(live(0.02763, false).costUsd).toBe(0.02763)
    expect(live(0.030052099999999998, false).costUsd).toBe(0.0024221)
    const resumed = createTurnCostTracker(0.030052099999999998)
    expect(resumed(0.031809899999999995, false).costUsd).toBe(0.0017578)
  })
})
