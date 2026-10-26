/**
 * The single formatter for a finding's review-state tag. Four prompt-render sites use it
 * (`distill/contract.ts`, `distill/v3/dossier.ts`, `rca/contract.ts`) plus the agent's own
 * `list_findings`. It lives here, and not in any one of them, because the same fact rendered
 * in four places is the exact shape that drifts.
 *
 * A NULL actor is a human reject — every rejection written before retraction existed was one.
 * A human reject renders its tag (spec 2026-10-25 §4.5); untagged stays bare `rejected`. The
 * agent's `reviewReason` is shown ONLY when the agent is the actor — a human reject over an
 * agent retraction keeps the agent text in the column but hides it (reviewFinding's rule).
 */
export function reviewTag(f: {
  reviewState: string
  reviewActor?: string | null
  reviewReason?: string | null
  rejectTag?: string | null
  rejectNote?: string | null
}): string {
  if (f.reviewState !== 'rejected') return f.reviewState
  if (f.reviewActor === 'agent') {
    return f.reviewReason
      ? `rejected · retracted by agent: ${f.reviewReason}`
      : 'rejected · retracted by agent'
  }
  if (f.rejectTag) {
    return f.rejectNote ? `rejected · ${f.rejectTag}: ${f.rejectNote}` : `rejected · ${f.rejectTag}`
  }
  return 'rejected'
}
