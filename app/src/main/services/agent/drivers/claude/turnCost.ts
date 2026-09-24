/**
 * Per-turn cost from the SDK's running total.
 *
 * `result.total_cost_usd` is NOT a per-turn figure. sdk.d.ts (0.3.281) documents it as
 * cumulative for the whole query() call — "each result carries the running total so far, so
 * read the latest result rather than summing across results" — and the Claude driver runs one
 * streaming query() per live session, so turn N's result already includes turns 1..N-1. Since
 * 0.3.281 a resumed query() also "continues from the total its transcript saved", so the first
 * result after an app restart carries every earlier turn too. Argus sums `turns.cost_usd` (and
 * the renderer sums `turn.completed` costs), so storing the raw total over-counted. This turns
 * it back into the turn's own spend. Measured in drivers/claude/__fixtures__/EVIDENCE.md.
 *
 * The total belongs to one SDK conversation (`result.session_id`), so the tracker keys it on
 * that id. A resume-seeded tracker starts in the resumed conversation (the resume cursor); a
 * fresh one starts in none.
 *
 * Rules, in order:
 *  1. no finite, non-negative number → cost unknown (null), running total unchanged;
 *  2. a zeroed error result ("crash/startup-error results may carry zeroed values") → cost 0,
 *     running total unchanged, and nothing to persist (it is not a real total);
 *  3. a conversation id that differs from the last one seen → that conversation's total
 *     started at zero (e.g. a /clear, which mints a new session id — Argus does not offer it,
 *     but typed as prompt text it still reaches the CLI) → the whole total is this turn's;
 *  4. total ≥ previous → the difference;
 *  5. total < previous → the SDK restarted its total without a new id (a resumed transcript
 *     that carried no saved total, or a result lacking a session id) → the whole total.
 */
export interface TurnCost {
  /** This turn's own spend in USD, or null when the SDK reported none. */
  costUsd: number | null
  /** The SDK's running total as reported — persisted as the next resume's baseline. Null when
   *  the result carried no usable total. */
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
