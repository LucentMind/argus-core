/**
 * Boundary `proposals.ts`'s `archive()` appends after an edited accept's original draft body,
 * and `evalExport.ts` splits on to recover the human's accepted text. Both modules import this
 * one constant rather than each hard-coding the string, so the two can never drift apart (this
 * repo has a documented defect class for exactly that: a fact written in two places that only
 * one side gets updated). The literal bytes on disk are `\n\n` + this constant + accepted text —
 * the leading blank line is spacing appended alongside the constant at the call site, not part
 * of the delimiter itself.
 */
export const ACCEPTED_CONTENT_DELIMITER = '\n<!-- accepted-content -->\n'

export const PROPOSAL_TYPES = [
  'skill-new',
  'skill-edit',
  'reference-edit',
  'recipe',
  'case-summary'
] as const
export type ProposalType = (typeof PROPOSAL_TYPES)[number]

export const PROPOSAL_TYPE_LABELS: Record<ProposalType, string> = {
  'skill-new': 'Skill · new',
  'skill-edit': 'Skill · edit',
  'reference-edit': 'Reference',
  recipe: 'Recipe',
  'case-summary': 'Case summary'
}

export interface ProposalRecord {
  file: string // file name inside proposals/
  type: ProposalType
  target: string // skill name, or reference file name (recipes name their target reference)
  caseSlug: string
  date: string
  title: string
  content: string // full proposed content (not a diff — the UI renders the diff)
  current: string | null // current content of the target; null when the target is new
  /** True when the target currently resolves to a non-hand-owned tier with no user copy yet
   *  — accept is refused; the UI disables Accept and shows why. */
  locked?: boolean
  /** distiller re-produced an item the user already accepted/rejected for this case */
  previouslyReviewed?: boolean
  /** distill job id that produced this proposal; absent for user-authored proposals */
  jobId?: string
  /** Evidence/reasoning the distiller cited for this proposal (staging's basis gate) — absent
   *  for user-authored proposals and pre-Task-14 distilled ones. */
  basis?: string
  /** A cross-case match: some OTHER case already rejected the same type+target. Absent when no
   *  such reject exists. `tag`/`note` mirror the matched reject's reason, when it recorded one —
   *  a "skip reason" reject stamps a bare `prior_reject_case` with neither, so `tag` stays
   *  optional rather than fabricated. */
  priorReject?: { tag?: string; caseSlug: string; note?: string }
}
export interface ProposalsPayload {
  proposals: ProposalRecord[]
}

/** Pending-set summary carried on the proposals:changed broadcast. */
export interface ProposalCounts {
  pendingCount: number
  byType: Partial<Record<ProposalType, number>>
}

/** What acceptProposal wrote, so the UI can offer the next step (e.g. share). */
export interface AcceptedTarget {
  kind: 'skill' | 'reference' | 'case-summary'
  name: string
}

/** Why a proposal was rejected — the label the distill-eval corpus trains on. */
export const REJECT_REASON_TAGS = ['overfit', 'overgeneric', 'wrong', 'duplicate', 'other'] as const
export type RejectReasonTag = (typeof REJECT_REASON_TAGS)[number]
export interface RejectReason {
  tag: RejectReasonTag
  note?: string
}
export const REJECT_REASON_LABELS: Record<RejectReasonTag, string> = {
  overfit: 'Too case-specific',
  overgeneric: 'Too generic',
  wrong: 'Wrong',
  duplicate: 'Duplicate',
  other: 'Other'
}
