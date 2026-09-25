/**
 * Per-turn cost from the SDK's running total.
 *
 * `result.total_cost_usd` is cumulative for the whole query() (sdk.d.ts 0.3.281), the driver
 * runs one query() per live session, and a resumed query() continues from the saved total.
 * Argus sums per-turn costs, so this recovers each turn's own spend (measured in EVIDENCE.md).
 * The total is keyed on its SDK conversation (`result.session_id`).
 *
 * Rules, in order:
 *  1. not a finite, non-negative number → cost null, total unchanged;
 *  2. zeroed error result → cost 0, total unchanged, nothing to persist;
 *  3. new conversation id (e.g. a typed /clear) → its total restarted: whole total;
 *  4. total ≥ previous → the difference;
 *  5. total < previous → the SDK reset without a new id: whole total.
 */
export interface TurnCost {
  /** This turn's own spend in USD, or null when the SDK reported none. */
  costUsd: number | null
  /** The SDK's running total as reported (the next resume's baseline), or null if unusable. */
  sdkTotalCostUsd: number | null
}

export type TurnCostTracker = (
  reportedTotal: unknown,
  isError: boolean,
  conversationId?: string | null
) => TurnCost

/** @param baseline the resumed conversation's saved total (0 for a fresh one)
 *  @param initialConversationId the conversation `baseline` belongs to (the resume cursor) */
export function createTurnCostTracker(
  baseline: number,
  initialConversationId?: string | null
): TurnCostTracker {
  let previous = Number.isFinite(baseline) && baseline > 0 ? baseline : 0
  let conversation = initialConversationId || null
  return (reportedTotal, isError, conversationId) => {
    if (typeof reportedTotal !== 'number' || !Number.isFinite(reportedTotal) || reportedTotal < 0) {
      return { costUsd: null, sdkTotalCostUsd: null }
    }
    if (isError && reportedTotal === 0) return { costUsd: 0, sdkTotalCostUsd: null }
    if (conversationId && conversationId !== conversation) {
      if (conversation !== null) previous = 0
      conversation = conversationId
    }
    const cost = reportedTotal >= previous ? reportedTotal - previous : reportedTotal
    previous = reportedTotal
    return { costUsd: roundUsd(cost), sdkTotalCostUsd: reportedTotal }
  }
}

/** Subtracting two float totals leaves noise like 0.19999999999999998. */
function roundUsd(v: number): number {
  return Math.round(v * 1e10) / 1e10
}
