/**
 * The single formatter for a finding's tag. Five render sites use it (`distill/contract.ts`,
 * `distill/v3/dossier.ts`, `rca/contract.ts`, `shared/findingTree.ts`'s `renderFindingTree`)
 * plus the agent's own review-mode `list_findings` line. It lives here, and not in any one of
 * them, because the same fact rendered in five places is the exact shape that drifts.
 *
 * Grammar (spec 2026-10-26 §9.2):
 *   superseded by #N                       — `supersededBy` set; nothing else, whatever the review
 *   <status> · <review>                    — when the row carries a status (hypothesis | confirmed)
 *   <review>                               — no status: a legacy snapshot row, or a review-mode row
 * The review part: `pending` / `accepted` / `rejected` / `rejected · retracted by agent: <reason>`
 * / `rejected · <tag>: <note>`. A NULL actor is a human reject — every rejection written before
 * retraction existed was one. The agent's `reviewReason` is shown ONLY when the agent is the
 * actor — a human reject over an agent retraction keeps the agent text in the column but hides
 * it (reviewFinding's rule).
 */
export function reviewTag(f: {
  reviewState: string
  reviewActor?: string | null
  reviewReason?: string | null
  rejectTag?: string | null
  rejectNote?: string | null
  status?: string | null
  supersededBy?: number | null
}): string {
  if (f.supersededBy != null) return `superseded by #${f.supersededBy}`
  const prefix = f.status === 'hypothesis' || f.status === 'confirmed' ? `${f.status} · ` : ''
  return prefix + reviewPart(f)
}

function reviewPart(f: {
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
