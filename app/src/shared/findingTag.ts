/**
 * The single formatter for a finding's review-state tag. Three prompt-render sites use it
 * (`distill/contract.ts`, `distill/v3/dossier.ts`, `rca/contract.ts`) plus the agent's own
 * `list_findings`. It lives here, and not in any one of them, because the same fact rendered
 * in four places is the exact shape that drifts.
 *
 * A NULL actor is a human reject — every rejection written before retraction existed was one.
 */
export function reviewTag(f: {
  reviewState: string
  reviewActor?: string | null
  reviewReason?: string | null
}): string {
  if (f.reviewState !== 'rejected' || f.reviewActor !== 'agent') return f.reviewState
  return f.reviewReason
    ? `rejected · retracted by agent: ${f.reviewReason}`
    : 'rejected · retracted by agent'
}
